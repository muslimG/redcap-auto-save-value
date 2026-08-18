/**
 * Auto-Save Value, offline layer
 *
 * Three jobs, in order of how much we care about them:
 *  1. never lose what somebody has typed, even if the page dies
 *  2. get it to the server as soon as the network allows
 *  3. never quietly overwrite somebody else's edit
 *
 * Everything on the device is encrypted with a key the browser will not let us
 * read back, so the drafts are useless if the storage is lifted off the tablet.
 *
 * Two rules the rest of this file follows, both learned the hard way:
 *
 *  - the DOM is the truth. Nothing is bookkept incrementally; the pending set is
 *    rebuilt from what is on the screen. That is what makes a deletion behave
 *    like any other edit instead of vanishing.
 *  - every tab mirrors to the device, always. Only sending is restricted to one
 *    tab at a time. An earlier version stood a second tab down completely, and
 *    everything typed into it was lost, which is a worse bug than the clobbering
 *    it was meant to prevent.
 */
$(function() {
    'use strict';

    // The action-tag layer hangs its own save(), init() and findInput() off the
    // external module object. This layer therefore keeps all of its state on a
    // separate object and borrows the module object for one thing only, ajax(),
    // which is the transport. Two layers sharing one namespace would be a very
    // quiet source of bugs.
    let module = (window.AutoSaveOffline = {});
    let transport = AutoSaveValueModule;
    let cfg = AutoSaveOfflineSettings;

    module.DB_NAME = 'autoSaveValueOffline';
    module.DB_VERSION = 1;
    module.STORE_KEYS = 'keys';
    module.STORE_DRAFTS = 'drafts';

    module.TYPING_DEBOUNCE = 600;   // ms of quiet before a keystroke becomes a draft
    module.AJAX_TIMEOUT = 30000;    // a request that never answers must not wedge the queue
    module.LEASE_RENEW = 2000;      // fallback election only
    module.LEASE_STALE = 6000;
    module.TAB_PROBE = 250;         // how long to wait for another tab to answer

    module.db = null;
    module.cryptoKey = null;
    module.baseline = {};        // what the server had when this page loaded
    module.lastKnownServer = {}; // updated as batches save, used for conflict checks
    module.pending = {};         // changed since the last successful save
    module.conflicted = {};      // fields waiting on the user to pick a side
    module.refused = {};         // field => { value, why } REDCap will not accept
    module.flushTimer = null;
    module.typingTimer = null;
    module.leaseTimer = null;
    module.retryDelay = 0;
    module.busy = false;
    module.running = false;      // handlers bound, mirroring to the device
    module.isLeader = false;     // this tab is the one allowed to talk to the server
    module.stopped = false;      // the server said retrying will never help
    module.storageBroken = false;
    module.draftId = null;       // not known until the tab token is settled
    module.draftChain = Promise.resolve();
    module.sendSeq = 0;          // every batch gets a number
    module.acceptedSeq = 0;      // the newest one whose answer we have used

    module.TAB_SLOT = 'asvo:tab';
    module.SUBMIT_FLAG = 'asvo:submitted';
    module.CHANNEL = 'asvo-tabs';

    module.recordKey = function() {
        return (cfg.record !== null && cfg.record !== '') ? cfg.record : 'new-record';
    };

    module.baseKey = [cfg.user, module.recordKey(), cfg.eventId, cfg.instrument, cfg.instance].join('|');
    module.lockName = 'asvo:sync:' + module.baseKey;
    module.leaseKey = 'asvo:lease:' + module.baseKey;

    /* ------------------------------------------------------------------ */
    /* which tab am I                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Every tab gets its own draft, so two tabs on one record cannot overwrite
     * each other's unsaved work. sessionStorage is the right home for the token:
     * it survives a reload and a captive portal bounce, which is the case this
     * module exists for, and it dies with the tab.
     *
     * The catch is that opening a link in a new tab copies sessionStorage, so the
     * clone starts life holding somebody else's token. Ask on a broadcast channel
     * whether anyone is already using it, and mint a new one if they answer.
     */
    module.settleTabToken = function() {
        let stored = null;
        try { stored = sessionStorage.getItem(module.TAB_SLOT); } catch (e) {}

        let mint = function() {
            let fresh = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
            try { sessionStorage.setItem(module.TAB_SLOT, fresh); } catch (e) {}
            return fresh;
        };

        if (!stored) return Promise.resolve(mint());
        if (typeof BroadcastChannel == 'undefined') return Promise.resolve(stored);

        return new Promise(function(resolve) {
            let answered = false;
            let probe = new BroadcastChannel(module.CHANNEL);

            probe.onmessage = function(e) {
                if (e.data && e.data.type == 'pong' && e.data.token == stored) answered = true;
            };
            probe.postMessage({ type: 'ping', token: stored });

            setTimeout(function() {
                probe.close();
                resolve(answered ? mint() : stored);
            }, module.TAB_PROBE);
        });
    };

    module.answerProbes = function() {
        if (typeof BroadcastChannel == 'undefined') return;
        module.channel = new BroadcastChannel(module.CHANNEL);
        module.channel.onmessage = function(e) {
            if (e.data && e.data.type == 'ping' && e.data.token == module.tabToken) {
                module.channel.postMessage({ type: 'pong', token: module.tabToken });
            }
        };
    };

    /**
     * A form that was genuinely submitted has been dealt with, so its draft must
     * not be offered to whatever the tab is pointed at next. This matters most
     * for new records, where consecutive participants would otherwise share one
     * draft key. The flag is cleared again if the page is still here two seconds
     * later, because REDCap cancels its own submit for required fields.
     */
    module.markSubmitted = function() {
        try { sessionStorage.setItem(module.SUBMIT_FLAG, String(Date.now())); } catch (e) {}
        setTimeout(function() {
            try { sessionStorage.removeItem(module.SUBMIT_FLAG); } catch (e) {}
        }, 2000);
    };

    module.previousPageSubmitted = function() {
        let flag = null;
        try { flag = sessionStorage.getItem(module.SUBMIT_FLAG); } catch (e) {}
        if (!flag) return false;
        try { sessionStorage.removeItem(module.SUBMIT_FLAG); } catch (e) {}
        return true;
    };

    /* ------------------------------------------------------------------ */
    /* one sender at a time                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Web Locks does exactly what is wanted here: the lock is held for as long as
     * the promise is unresolved, and the browser releases it the moment the tab
     * goes away, crash included. No heartbeat, no stale lease, no two tabs both
     * believing they are in charge. The localStorage fallback below is only for
     * browsers without it.
     */
    module.electLeader = function() {
        if (navigator.locks && navigator.locks.request) {
            navigator.locks.request(module.lockName, { mode: 'exclusive' }, function() {
                module.becomeLeader();
                return new Promise(function() {}); // held until this tab is gone
            }).catch(function() { module.leaseElection(); });
            return;
        }
        module.leaseElection();
    };

    module.leaseElection = function() {
        let tryClaim = function() {
            let now = Date.now();
            let held = null;
            try {
                let raw = localStorage.getItem(module.leaseKey);
                if (raw) held = JSON.parse(raw);
            } catch (e) {
                module.becomeLeader();
                return;
            }

            if (held && held.tab != module.tabToken && (now - held.at) < module.LEASE_STALE) {
                // somebody else holds it. If that somebody is not us and we
                // thought we were in charge, stand down: a background tab's
                // timers are throttled to once a minute, so losing a six second
                // lease without noticing is routine, and two senders is exactly
                // what this election exists to prevent.
                if (module.isLeader) {
                    module.isLeader = false;
                    module.setStatus();
                }
                return;
            }

            try { localStorage.setItem(module.leaseKey, JSON.stringify({ tab: module.tabToken, at: now })); } catch (e) {}
            module.becomeLeader();
        };

        tryClaim();
        module.leaseTimer = setInterval(tryClaim, module.LEASE_RENEW);
    };

    module.becomeLeader = function() {
        if (module.isLeader) return;
        module.isLeader = true;
        // deliberately no re-reading of the baseline here. It was captured when
        // this page loaded, and anything typed since then is a real change.
        module.setStatus();
        if (Object.keys(module.pending).length) module.flush();
    };

    module.releaseLease = function() {
        if (!module.leaseTimer) return;
        try {
            let raw = localStorage.getItem(module.leaseKey);
            if (raw && JSON.parse(raw).tab == module.tabToken) localStorage.removeItem(module.leaseKey);
        } catch (e) {}
    };

    /* ------------------------------------------------------------------ */
    /* device storage                                                      */
    /* ------------------------------------------------------------------ */

    module.openDb = function() {
        return new Promise(function(resolve, reject) {
            let req = indexedDB.open(module.DB_NAME, module.DB_VERSION);
            req.onupgradeneeded = function(e) {
                let db = e.target.result;
                if (!db.objectStoreNames.contains(module.STORE_KEYS)) db.createObjectStore(module.STORE_KEYS);
                if (!db.objectStoreNames.contains(module.STORE_DRAFTS)) db.createObjectStore(module.STORE_DRAFTS);
            };
            req.onsuccess = function(e) { resolve(e.target.result); };
            req.onerror = function(e) { reject(e.target.error); };
            req.onblocked = function() { reject(new Error('another tab is holding an old version of the database')); };
        });
    };

    module.idbPut = function(store, key, value) {
        return new Promise(function(resolve, reject) {
            let tx = module.db.transaction(store, 'readwrite');
            tx.objectStore(store).put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = function(e) { reject(e.target.error); };
            tx.onabort = function(e) { reject(e.target.error || new Error('transaction aborted')); };
        });
    };

    module.idbGet = function(store, key) {
        return new Promise(function(resolve, reject) {
            let tx = module.db.transaction(store, 'readonly');
            let req = tx.objectStore(store).get(key);
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function(e) { reject(e.target.error); };
            tx.onabort = function(e) { reject(e.target.error || new Error('transaction aborted')); };
        });
    };

    module.idbDelete = function(store, key) {
        return new Promise(function(resolve, reject) {
            let tx = module.db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = resolve;
            tx.onerror = function(e) { reject(e.target.error); };
            tx.onabort = function(e) { reject(e.target.error || new Error('transaction aborted')); };
        });
    };

    module.idbEachDraft = function(callback) {
        return new Promise(function(resolve, reject) {
            let tx = module.db.transaction(module.STORE_DRAFTS, 'readwrite');
            let req = tx.objectStore(module.STORE_DRAFTS).openCursor();
            req.onsuccess = function() {
                let cursor = req.result;
                if (!cursor) { resolve(); return; }
                callback(cursor);
                cursor.continue();
            };
            req.onerror = function(e) { reject(e.target.error); };
        });
    };

    /**
     * One AES-GCM key per browser, generated once and kept as a CryptoKey rather
     * than as bytes. extractable:false means there is no way to read the key back
     * out again, not from here and not from the console, so lifting the IndexedDB
     * file off the device gets you ciphertext and nothing else.
     */
    module.loadKey = async function() {
        let keyName = 'aes:' + cfg.user;
        let existing = await module.idbGet(module.STORE_KEYS, keyName);
        if (existing) return existing;

        let key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await module.idbPut(module.STORE_KEYS, keyName, key);
        return key;
    };

    module.encrypt = async function(obj) {
        let iv = crypto.getRandomValues(new Uint8Array(12));
        let plain = new TextEncoder().encode(JSON.stringify(obj));
        let cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, module.cryptoKey, plain);
        return { iv: Array.from(iv), body: Array.from(new Uint8Array(cipher)) };
    };

    module.decrypt = async function(blob) {
        let iv = new Uint8Array(blob.iv);
        let body = new Uint8Array(blob.body);
        let plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, module.cryptoKey, body);
        return JSON.parse(new TextDecoder().decode(plain));
    };

    /**
     * Queued behind whatever draft write is already in flight. Two encrypt calls
     * finishing out of order would otherwise leave the older snapshot on disk,
     * which is the one thing a draft store must never do.
     */
    module.saveDraft = function() {
        if (!module.db || !module.cryptoKey || !module.draftId) return module.draftChain;

        module.draftChain = module.draftChain.then(async function() {
            try {
                let blob = await module.encrypt({ values: module.readForm(), pending: module.pending });
                await module.idbPut(module.STORE_DRAFTS, module.draftId, {
                    savedAt: Date.now(),
                    ttlHours: cfg.ttlHours,
                    base: module.baseKey,
                    tab: module.tabToken,
                    user: cfg.user,
                    record: cfg.record,
                    instrument: cfg.instrument,
                    blob: blob
                });
                if (module.storageBroken) { module.storageBroken = false; module.setStatus(); }
            } catch (err) {
                console.log('Auto-Save Value: could not write draft', err);
                module.storageBroken = true;
                module.setStatus();
            }
        });
        return module.draftChain;
    };

    /**
     * Our own draft first. Failing that, a draft left behind by a tab that died
     * on the same record: that is the whole point of the exercise, and per-tab
     * keys would otherwise make an orphan unreachable.
     */
    module.readDraft = async function() {
        let row = await module.idbGet(module.STORE_DRAFTS, module.draftId);
        if (row && module.expired(row)) {
            await module.idbDelete(module.STORE_DRAFTS, module.draftId);
            row = null;
        }
        if (!row) row = await module.findOrphanDraft();
        if (!row) return null;

        try {
            let opened = await module.decrypt(row.blob);
            opened.savedAt = row.savedAt;
            opened.fromAnotherTab = (row.tab != module.tabToken);
            return opened;
        } catch (err) {
            // Wrong key. Almost always a different user on the same tablet, whose
            // draft this is. Leave it alone: deleting it would destroy somebody
            // else's unsaved work to tidy up our own screen. TTL will clear it.
            console.log('Auto-Save Value: a draft here could not be opened with this key, leaving it');
            return null;
        }
    };

    module.findOrphanDraft = async function() {
        let candidates = [];
        await module.idbEachDraft(function(cursor) {
            let row = cursor.value;
            if (!row || row.base != module.baseKey) return;
            if (row.tab == module.tabToken) return;
            if (module.expired(row)) { cursor.delete(); return; }
            candidates.push(row);
        });
        if (!candidates.length) return null;
        candidates.sort(function(a, b) { return b.savedAt - a.savedAt; });
        return candidates[0];
    };

    module.dropDraft = function() {
        if (!module.draftId) return Promise.resolve();
        return module.idbDelete(module.STORE_DRAFTS, module.draftId);
    };

    // rows carry the TTL they were written under, so changing the setting does
    // not retrospectively bin drafts that were still inside the old window
    module.expired = function(row) {
        if (!row || !row.savedAt) return true;
        let limit = row.ttlHours ? row.ttlHours : cfg.ttlHours;
        return module.hoursSince(row.savedAt) > limit;
    };

    module.purgeStaleDrafts = function() {
        return module.idbEachDraft(function(cursor) {
            if (module.expired(cursor.value)) cursor.delete();
        });
    };

    module.hoursSince = function(when) {
        return (Date.now() - when) / 3600000;
    };

    /* ------------------------------------------------------------------ */
    /* reading and writing the form                                        */
    /* ------------------------------------------------------------------ */

    // field names come from the project's own data dictionary, but they are
    // still being pasted into a selector, so put them through the escaper
    module.sel = function(name) {
        if (window.CSS && CSS.escape) return CSS.escape(name);
        return String(name).replace(/["\\]/g, '\\$&');
    };


    /**
     * One checkbox choice, as REDCap actually renders it.
     *
     * Verified against REDCap 17.0.3 on 14 Aug 2026, because this was wrong
     * before and nothing caught it: the mock form used in the tests had invented
     * the markup. Real REDCap renders a choice as
     *
     *   <input type="checkbox" id="id-__chk__<field>_RC_<code>" name="__chkn__<field>" value="on">
     *
     * with a hidden partner <input name="__chk__<field>_RC_<code>"> that carries
     * the code when ticked and an empty string when not. There is no element
     * anywhere named <field>___<code>; that is the name the saveData API wants,
     * which is a different thing and is why the server side was right all along.
     *
     * getElementById rather than a name selector, because the id is unique and
     * needs no escaping.
     */
    module.checkboxInput = function(field, code) {
        let byId = document.getElementById('id-__chk__' + field + '_RC_' + code);
        if (byId) return $(byId);
        // fall back to the flat naming, for any rendering that uses it
        return $('input[type=checkbox][name="' + module.sel(field + '___' + code) + '"]');
    };

    module.readField = function(field) {
        let spec = cfg.fields[field];
        if (!spec) return null;

        if (spec.type == 'checkbox') {
            let ticked = [];
            let seen = 0;
            spec.choices.forEach(function(code) {
                let box = module.checkboxInput(field, code);
                if (!box.length) return;
                seen++;
                if (box.prop('checked')) ticked.push(String(code));
            });
            if (!seen) return null;
            ticked.sort();
            return ticked;
        }

        let input = $('[name="' + module.sel(field) + '"]').not('[type=radio]').first();
        if (!input.length) return null;
        return input.val();
    };

    /** which choices of a checkbox group this page actually rendered */
    module.visibleChoices = function(field) {
        let spec = cfg.fields[field];
        if (!spec || spec.type != 'checkbox') return null;
        return spec.choices.filter(function(code) {
            return module.checkboxInput(field, code).length > 0;
        }).map(String);
    };

    module.readForm = function() {
        let values = {};
        Object.keys(cfg.fields).forEach(function(field) {
            let v = module.readField(field);
            if (v !== null) values[field] = v;
        });
        return values;
    };

    /**
     * Radios and checkboxes get a real click rather than a property assignment.
     * REDCap keeps the submitted value in a parallel hidden input that only its
     * own handler updates, so setting .checked alone shows the right thing on
     * screen and submits the wrong thing.
     */
    module.writeField = function(field, value) {
        let spec = cfg.fields[field];
        if (!spec) return;

        if (spec.type == 'checkbox') {
            let wanted = (value || []).map(String);
            spec.choices.forEach(function(code) {
                let box = module.checkboxInput(field, code);
                if (!box.length) return;
                let shouldBeOn = wanted.indexOf(String(code)) > -1;
                if (box.prop('checked') != shouldBeOn) box.trigger('click');
            });
            return;
        }

        if (spec.type == 'radio' || spec.type == 'yesno' || spec.type == 'truefalse') {
            if (value === '' || value === null || typeof value == 'undefined') {
                module.clearRadio(field);
                return;
            }
            let button = $('input[type=radio][name="' + module.sel(field + '___radio') + '"][value="' + module.sel(value) + '"]');
            if (button.length) {
                if (!button.prop('checked')) button.trigger('click');
                return;
            }
            // No rendered button carries this value: a missing-data code, or a
            // choice hidden by @HIDECHOICE. Clear the group first, otherwise the
            // screen keeps showing the old answer while the submitted value
            // changes underneath it.
            module.clearRadio(field);
        }

        let input = $('[name="' + module.sel(field) + '"]').not('[type=radio]').first();
        if (!input.length || input.val() == value) return;
        input.val(value);
        module.syncAutocompleteLabel(input);
        input.trigger('change');
    };

    /**
     * Clearing a radio is not the same as clicking one. There is no button whose
     * value is blank, so an earlier version did nothing at all and left the
     * visible button selected while the stored value went empty.
     *
     * REDCap's own reset link is the right tool where it exists, but it has to be
     * matched on the exact field name. A substring match picks up the link for
     * pain_score when asked to clear pain, and then clears the wrong field.
     */
    module.clearRadio = function(field) {
        let group = $('input[type=radio][name="' + module.sel(field + '___radio') + '"]');
        if (!group.filter(':checked').length) return;

        // REDCap does render a reset link, radioResetVal('<field>','form'), but
        // calling it on 17.0.3 has no effect: tested on a live form, the value
        // and the checked state both survived it. So undo both halves by hand,
        // which was tested on the same form and does work. Doing it this way also
        // removes a whole class of bug, because there is no link to match and so
        // no way to match the wrong field's link.
        group.prop('checked', false);
        let hidden = $('[name="' + module.sel(field) + '"]').not('[type=radio]').first();
        if (hidden.length) {
            hidden.val('');
            hidden.trigger('change');
        }
    };

    /**
     * Put a draft back. A blank in the draft is never written over something the
     * user has already typed since the page came back, because the restore button
     * is a recovery action and must not be able to destroy work.
     */
    module.writeForm = function(values, onlyThese) {
        let skipped = [];
        let allowed = onlyThese ? Object.keys(onlyThese) : Object.keys(values);
        allowed.forEach(function(field) {
            if (!(field in values)) return;
            let draftValue = values[field];
            let live = module.readField(field);
            let draftBlank = (draftValue === '' || (Array.isArray(draftValue) && !draftValue.length));
            let liveBlank = (live === null || live === '' || (Array.isArray(live) && !live.length));

            // Is the box still showing what the page loaded with, or has the user
            // typed into it since? The baseline is what REDCap rendered from the
            // database on this load, so anything different is the user's own new
            // work and must not be overwritten by a restore. Anything the same is
            // just the older server value, which is exactly what the draft is
            // here to replace.
            let untouchedSinceLoad = !module.valuesDiffer(live, module.baseline[field]);
            if (!untouchedSinceLoad) { skipped.push(field); return; }
            if (draftBlank && !liveBlank) { skipped.push(field); return; }
            module.writeField(field, draftValue);
        });
        module.recalculate();
        return skipped;
    };

    // the autocomplete dropdowns keep the label in a sibling text box
    /**
     * The autocomplete dropdown keeps its label in a separate visible box. REDCap
     * gives that box a unique id, rc-ac-input_<field>, which is what to target:
     * a container search picks up every autocomplete in the same block, and a
     * descriptive field with two embedded autocompletes will then show one
     * field's label against the other field's box.
     */
    module.syncAutocompleteLabel = function(input) {
        if (!input.is('select.rc-autocomplete')) return;
        let label = input.find('option:selected').text();
        let name = input.attr('name');
        let box = name ? $(document.getElementById('rc-ac-input_' + name)) : $();
        if (!box.length) box = input.closest('div,td').find('input.rc-autocomplete').first();
        box.val(label);
    };

    module.recalculate = function() {
        try { if (typeof doBranching == 'function') doBranching(); } catch (e) {}
        try { if (typeof calculate == 'function') calculate(); } catch (e) {}
    };

    /**
     * Joined on a space, not on nothing. ['1','23'] and ['12','3'] both come out
     * as "123" if you join on the empty string, so two genuinely different sets
     * of ticks compared as equal and the change was dropped. Any checkbox with
     * ten or more choices could hit that.
     *
     * An array against a string is a mismatch of shapes, not of values, and it
     * used to throw and take the whole module down with it.
     */
    module.valuesDiffer = function(a, b) {
        let aList = Array.isArray(a), bList = Array.isArray(b);
        if (aList || bList) {
            if (aList != bList) return true;
            let x = a.map(String).sort();
            let y = b.map(String).sort();
            return x.join(' ') != y.join(' ');
        }
        return String(a == null ? '' : a) !== String(b == null ? '' : b);
    };

    /* ------------------------------------------------------------------ */
    /* syncing                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Rebuild the pending set from what is on the screen right now, rather than
     * bookkeeping it incrementally. Doing it this way is what makes a deletion
     * behave like any other edit: an emptied box differs from what the server
     * holds, so it goes back in the queue instead of quietly disappearing.
     */
    module.recomputePending = function() {
        let now = module.readForm();

        Object.keys(now).forEach(function(field) {
            let value = now[field];

            // the user has gone back and changed a field somebody else also
            // changed. Take that as their answer: their text wins, over the
            // value the server reported.
            if (module.conflicted[field] && module.valuesDiffer(value, module.conflicted[field].mine)) {
                module.resolveConflict(field, 'mine');
            }

            if (module.refused[field]) {
                if (!module.valuesDiffer(value, module.refused[field].value)) {
                    // still the value REDCap would not take. Do not queue it and do
                    // not pretend it is saved.
                    delete module.pending[field];
                    module.showRefusal(field, module.refused[field].why);
                    return;
                }
                // corrected, so let it through again
                delete module.refused[field];
                $('.asvo-refusal[data-asvo-field="' + module.sel(field) + '"]').remove();
            }

            if (module.valuesDiffer(value, module.lastKnownServer[field])) {
                module.pending[field] = value;
            } else {
                delete module.pending[field];
            }
        });

        // a field that has left the page, hidden by branching or a repeating table
        // redraw, cannot be re-read. If the server already agrees with what we
        // last sent, stop carrying it, otherwise it is retried forever.
        Object.keys(module.pending).forEach(function(field) {
            if (module.readField(field) !== null) return;
            if (!module.valuesDiffer(module.pending[field], module.lastKnownServer[field])) delete module.pending[field];
        });
    };

    module.stalledCount = function() {
        return Object.keys(module.refused).length;
    };

    module.noteChanges = function() {
        module.recomputePending();
        module.saveDraft();
        module.scheduleFlush();
        module.setStatus();
    };

    module.scheduleFlush = function() {
        if (module.flushTimer || module.stopped) return;
        let wait = module.retryDelay || (cfg.flushSeconds * 1000);
        module.flushTimer = setTimeout(function() {
            module.flushTimer = null;
            module.flush();
        }, wait);
    };

    module.flush = function() {
        if (!cfg.syncEnabled || !module.running || !module.isLeader || module.stopped) return;
        if (module.busy) { module.scheduleFlush(); return; }

        // anything the user still has to make a decision about stays out of the
        // batch, otherwise it is re-sent every cycle and stacks up a new panel
        // each time
        let sendable = Object.keys(module.pending).filter(function(f) { return !module.conflicted[f]; });

        if (!sendable.length) { module.retryDelay = 0; module.setStatus(); return; }

        if (!navigator.onLine) {
            module.setStatus('queued');
            module.retryDelay = 15000;
            module.scheduleFlush();
            return;
        }

        let batch = {};
        sendable.slice(0, 200).forEach(function(field) {
            batch[field] = { value: module.pending[field], seen: module.serverValue(field) };
            let choices = module.visibleChoices(field);
            if (choices) batch[field].choices = choices;
        });

        module.busy = true;
        module.setStatus('sending');

        // Number every batch. A request that timed out is abandoned, not
        // cancelled, so it can still arrive later and its answer would describe
        // a world two edits out of date. Acting on it sets lastKnownServer back
        // and leaves the screen and the database permanently disagreeing, with
        // nothing left in the queue to correct it.
        let seq = ++module.sendSeq;
        let stale = function() { return seq <= module.acceptedSeq; };

        module.withTimeout(transport.ajax(cfg.syncAction, { changes: batch })).then(function(response) {
            if (stale()) { console.log('Auto-Save Value: ignoring a late answer for batch ' + seq); return; }
            module.acceptedSeq = seq;
            module.busy = false;

            if (!response || typeof response != 'object') {
                module.backOff();
                return;
            }

            (response.saved || []).forEach(function(field) {
                module.lastKnownServer[field] = batch[field].value;
                delete module.refused[field];
                $('.asvo-refusal[data-asvo-field="' + module.sel(field) + '"]').remove();
            });

            (response.notes || []).forEach(function(note) {
                console.log('Auto-Save Value: REDCap noted - ' + note);
            });

            Object.keys(response.rejected || {}).forEach(function(field) {
                if (!batch[field]) return;
                module.refused[field] = { value: batch[field].value, why: response.rejected[field] };
                console.log('Auto-Save Value: REDCap refused ' + field + ' - ' + response.rejected[field]);
                module.showRefusal(field, response.rejected[field]);
            });

            (response.conflicts || []).forEach(function(clash) { module.showConflict(clash); });

            if ((response.errors || []).length) {
                console.log('Auto-Save Value: server reported', response.errors);
                if (response.terminal) {
                    module.stopped = true;
                    module.showStopped(response.errors.join('; '));
                    module.setStatus();
                    return;
                }
                // a hard error means nothing in the batch was written, so hold the
                // queue and try again rather than dropping it on the floor
                module.backOff();
                return;
            }

            module.retryDelay = 0;
            // recompute, do not delete. The user may well have kept typing while
            // that request was in the air, and the value we sent is already stale.
            module.recomputePending();
            module.saveDraft();
            module.setStatus();
            if (Object.keys(module.pending).length) module.scheduleFlush();
        }).catch(function(err) {
            if (stale()) return;
            module.acceptedSeq = seq;
            module.busy = false;
            console.log('Auto-Save Value: sync failed, keeping the queue', err);
            module.backOff();
        });
    };

    /**
     * A roaming tablet does not always get a refusal, it sometimes gets silence.
     * Without this the promise never settles, busy stays true and the queue is
     * wedged for the life of the page while the pill says it is waiting.
     */
    module.withTimeout = function(promise) {
        return new Promise(function(resolve, reject) {
            let done = false;
            let timer = setTimeout(function() {
                if (done) return;
                done = true;
                reject(new Error('no answer from the server'));
            }, module.AJAX_TIMEOUT);

            promise.then(function(v) {
                if (done) return;
                done = true; clearTimeout(timer); resolve(v);
            }, function(e) {
                if (done) return;
                done = true; clearTimeout(timer); reject(e);
            });
        });
    };

    module.serverValue = function(field) {
        let held = module.lastKnownServer[field];
        if (typeof held == 'undefined') return (cfg.fields[field] && cfg.fields[field].type == 'checkbox') ? [] : '';
        return held;
    };

    // 5s, 10s, 20s, 40s, then settle at a minute
    module.backOff = function() {
        module.retryDelay = module.retryDelay ? Math.min(module.retryDelay * 2, 60000) : 5000;
        module.setStatus('queued');
        module.scheduleFlush();
    };

    /* ------------------------------------------------------------------ */
    /* what the user sees                                                  */
    /* ------------------------------------------------------------------ */

    module.host = function() {
        let center = $('#center');
        if (center.length) return center;
        let form = $('#form');
        if (form.length) return form;
        return $('body');
    };

    module.setStatus = function(state) {
        if (!cfg.showStatus) return;
        let pill = $('#asvo-status');
        if (!pill.length) pill = $('<div id="asvo-status" class="asvo-status"></div>').appendTo('body');

        let waiting = Object.keys(module.pending).length;
        let clashes = Object.keys(module.conflicted).length;
        let stalled = module.stalledCount();

        // these override whatever the caller asked for, because they are the
        // states the user most needs to know about
        if (module.storageBroken) state = 'broken';
        else if (module.stopped) state = 'stopped';
        else if (clashes) state = 'clash';
        else if (stalled) state = 'stalled';
        else if (!state) {
            if (!cfg.syncEnabled) state = 'device-only';
            else if (!module.isLeader) state = 'standby';
            else state = waiting ? 'queued' : 'clean';
        }

        pill.removeClass('asvo-clean asvo-queued asvo-sending asvo-broken asvo-standby');

        if (state == 'broken') {
            pill.addClass('asvo-broken').text('On-device backup FAILED');
        } else if (state == 'stopped') {
            pill.addClass('asvo-broken').text('Saving stopped, see the message above');
        } else if (state == 'clash') {
            pill.addClass('asvo-broken').text(clashes + (clashes == 1 ? ' change needs' : ' changes need') + ' your decision');
        } else if (state == 'stalled') {
            pill.addClass('asvo-broken').text(stalled + (stalled == 1 ? ' value was' : ' values were') + ' not accepted');
        } else if (state == 'device-only') {
            pill.addClass('asvo-standby').text(waiting ? 'Held on this device, not saved yet' : 'Held on this device');
        } else if (state == 'standby') {
            pill.addClass('asvo-standby').text(waiting ? 'Held on this device, another tab is saving' : 'Another tab is saving this record');
        } else if (state == 'sending') {
            pill.addClass('asvo-sending').text('Saving ' + waiting + ' change' + (waiting == 1 ? '' : 's'));
        } else if (state == 'queued') {
            pill.addClass('asvo-queued').text((navigator.onLine ? 'Waiting to save ' : 'Offline, holding ') + waiting + ' change' + (waiting == 1 ? '' : 's'));
        } else {
            pill.addClass('asvo-clean').text('All changes saved');
        }
    };

    module.showRestoreBar = function(draft) {
        let minutes = Math.max(1, Math.round((Date.now() - draft.savedAt) / 60000));
        let bar = $('<div class="asvo-bar"></div>');
        let caveat = draft.fromAnotherTab
            ? ' These came from another window on this device, so check they belong to this participant before putting them back.'
            : '';

        $('<div class="asvo-bar-text"></div>').html(
            '<strong>Unsaved work found on this device.</strong> This form was being filled in about ' +
            minutes + ' minute' + (minutes == 1 ? '' : 's') + ' ago and some answers never reached the server. ' +
            'That usually means the page reloaded or the connection dropped.' + caveat +
            ' Only fields this module can see are covered, so check the whole form afterwards.'
        ).appendTo(bar);

        let buttons = $('<div class="asvo-bar-buttons"></div>').appendTo(bar);

        $('<button type="button" class="asvo-btn asvo-btn-go">Put my answers back</button>')
            .on('click', function() {
                // only the fields the draft recorded as unsaved. Everything else
                // in the draft is a stale copy of what the server held when the
                // page died, and writing it back would silently overwrite an edit
                // somebody else has made since, with a baseline that matches.
                let skipped = module.writeForm(draft.values, draft.pending || draft.values);
                module.noteChanges();
                bar.remove();
                if (skipped.length) {
                    module.showNote('The draft was blank for ' + skipped.length + ' field' + (skipped.length == 1 ? '' : 's') +
                                    ' you have already filled in since, so those were left as they are.');
                }
            }).appendTo(buttons);

        $('<button type="button" class="asvo-btn">Discard</button>')
            .on('click', function() {
                if (!confirm('Throw away the unsaved answers held on this device?')) return;
                module.dropDraft();
                bar.remove();
            }).appendTo(buttons);

        module.host().prepend(bar);
        module.scrollTo(bar);
    };

    module.showConflict = function(clash) {
        if (module.conflicted[clash.field]) return; // already asking about this one
        module.conflicted[clash.field] = clash;

        let mine = Array.isArray(clash.mine) ? clash.mine.join(', ') : clash.mine;
        let theirs = Array.isArray(clash.theirs) ? clash.theirs.join(', ') : clash.theirs;
        let panel = $('<div class="asvo-bar asvo-clash"></div>').attr('data-asvo-field', clash.field);

        $('<div class="asvo-bar-text"></div>').html(
            '<strong>Somebody else changed ' + module.escapeHtml(clash.field) + ' while you were offline.</strong><br>' +
            'Yours: <code>' + module.escapeHtml(mine || '(blank)') + '</code> &nbsp; ' +
            'Already saved: <code>' + module.escapeHtml(theirs || '(blank)') + '</code><br>' +
            'You can also just correct the field itself, and your correction will be saved.'
        ).appendTo(panel);

        let buttons = $('<div class="asvo-bar-buttons"></div>').appendTo(panel);

        $('<button type="button" class="asvo-btn asvo-btn-go">Keep mine</button>')
            .on('click', function() { module.resolveConflict(clash.field, 'mine'); }).appendTo(buttons);

        $('<button type="button" class="asvo-btn">Keep theirs</button>')
            .on('click', function() { module.resolveConflict(clash.field, 'theirs'); }).appendTo(buttons);

        module.host().prepend(panel);
        module.scrollTo(panel);
        module.setStatus();
    };

    module.resolveConflict = function(field, side) {
        let clash = module.conflicted[field];
        if (!clash) return;

        // their value becomes the base either way: it is what the server holds now
        module.lastKnownServer[field] = clash.theirs;
        delete module.conflicted[field];
        delete module.refused[field];
        $('.asvo-clash[data-asvo-field="' + module.sel(field) + '"]').remove();

        if (side == 'theirs') {
            delete module.pending[field];
            module.writeField(field, clash.theirs);
            module.recalculate();
            module.saveDraft();
            module.setStatus();
            return;
        }

        // read the box, do not trust the value that was in flight when the clash
        // happened. The user has very likely typed since.
        let live = module.readField(field);
        if (live !== null) module.pending[field] = live;
        module.retryDelay = 0;
        module.setStatus();
        module.flush();
    };

    /**
     * REDCap would not take a value. Say so once, next to nothing, rather than
     * retrying it silently every ten seconds until the tablet is closed. The
     * panel goes away by itself when the field is corrected and saves.
     */
    module.showRefusal = function(field, why) {
        if ($('.asvo-refusal[data-asvo-field="' + module.sel(field) + '"]').length) return;

        let panel = $('<div class="asvo-bar asvo-clash asvo-refusal"></div>').attr('data-asvo-field', field);
        $('<div class="asvo-bar-text"></div>').html(
            '<strong>REDCap would not accept ' + module.escapeHtml(field) + ', so it has not been saved.</strong><br>' +
            module.escapeHtml(why) + '<br>Correct the value and it will be sent again. Everything else on the form saved normally.'
        ).appendTo(panel);

        module.host().prepend(panel);
        module.scrollTo(panel);
    };

    module.showStopped = function(why) {
        if ($('.asvo-stopped').length) return;
        let panel = $('<div class="asvo-bar asvo-clash asvo-stopped"></div>');
        $('<div class="asvo-bar-text"></div>').html(
            '<strong>Background saving has stopped for this form.</strong><br>' +
            module.escapeHtml(why) + '<br>' +
            'Your answers are still on this device and still on screen, but they are not being written to the database. ' +
            'Save the form by hand, or tell the study team before you close this page.'
        ).appendTo(panel);
        $('<div class="asvo-bar-buttons"></div>')
            .append($('<button type="button" class="asvo-btn asvo-btn-go">Try again</button>')
                .on('click', function() { module.rearm(); module.retryDelay = 0; module.flush(); }))
            .appendTo(panel);
        module.host().prepend(panel);
        module.scrollTo(panel);
    };

    module.showNote = function(text) {
        let panel = $('<div class="asvo-bar"></div>');
        $('<div class="asvo-bar-text"></div>').text(text).appendTo(panel);
        $('<div class="asvo-bar-buttons"></div>')
            .append($('<button type="button" class="asvo-btn">OK</button>').on('click', function() { panel.remove(); }))
            .appendTo(panel);
        module.host().prepend(panel);
        module.scrollTo(panel);
    };

    // a 77 field form is a long way from top to bottom, and a panel prepended out
    // of sight is a panel nobody reads
    module.scrollTo = function(el) {
        try { el[0].scrollIntoView({ block: 'center' }); } catch (e) {}
    };

    module.escapeHtml = function(s) {
        return $('<div></div>').text(s == null ? '' : s).html();
    };

    /* ------------------------------------------------------------------ */

    /**
     * The handlers. 'change' on a text box only fires at blur, which is why an
     * earlier version captured nothing from somebody who typed a paragraph and
     * then walked away, so 'input' is bound as well and debounced. On top of
     * that, anything that looks like the page is about to go away forces a save
     * immediately rather than waiting for the timer.
     */
    module.bindHandlers = function() {
        let form = $('#form').length ? $('#form') : $(document);

        form.on('change blur', 'input, select, textarea', function() {
            clearTimeout(module.typingTimer);
            setTimeout(module.noteChanges, 50); // let REDCap's own handlers land first
        });

        form.on('input', 'input, textarea', function() {
            clearTimeout(module.typingTimer);
            module.typingTimer = setTimeout(module.noteChanges, module.TYPING_DEBOUNCE);
        });

        $(document).on('visibilitychange', function() {
            if (document.visibilityState == 'hidden') {
                clearTimeout(module.typingTimer);
                module.noteChanges();
                module.flush();
            }
        });

        $(window).on('pagehide', function() {
            clearTimeout(module.typingTimer);
            module.recomputePending();
            module.saveDraft();       // best effort, the browser may not let it finish
            module.releaseLease();
        });

        $(window).on('online', function() {
            module.retryDelay = 0;
            // a refusal can be permanent (no rights) or merely current (the form
            // was locked, the locking table was briefly unreadable). Coming back
            // online is a reasonable moment to find out which, rather than
            // stranding the rest of the shift's work behind one bad answer.
            module.rearm();
            module.flush();
        });
        $(window).on('offline', function() { module.setStatus('queued'); });

        // The queue is deliberately NOT cleared here. An earlier version emptied
        // it on submit, but REDCap cancels its own submit for required fields and
        // validation, so a cancelled save silently threw away everything queued.
        // All this does is remember that a real submit happened, so the draft is
        // not offered to the next form this tab is pointed at.
        form.on('submit', function() { module.markSubmitted(); });
    };

    /** let a stopped module try once more */
    module.rearm = function() {
        if (!module.stopped) return;
        module.stopped = false;
        $('.asvo-stopped').remove();
        module.setStatus();
    };

    module.start = async function() {
        // Baseline first, before anything that can await. Opening IndexedDB and
        // generating a 256 bit key together take long enough on a tablet that
        // anything typed in the gap used to be read back as what the server
        // already had, so it was never sent anywhere.
        module.baseline = module.readForm();
        module.lastKnownServer = $.extend(true, {}, module.baseline);
        module.running = true;

        module.bindHandlers();
        let submitted = module.previousPageSubmitted();
        module.tabToken = await module.settleTabToken();
        module.draftId = module.baseKey + '|' + module.tabToken;
        module.answerProbes();
        if (cfg.syncEnabled) module.electLeader();
        module.setStatus();

        try {
            module.db = await module.openDb();
            module.cryptoKey = await module.loadKey();
        } catch (err) {
            console.log('Auto-Save Value: no usable device storage', err);
            module.storageBroken = true;
            module.setStatus();
            module.recomputePending();      // the queue still works without a mirror
            if (Object.keys(module.pending).length) module.scheduleFlush();
            return;
        }

        try { await module.purgeStaleDrafts(); } catch (e) {}

        // anything typed during those awaits is a real change, so pick it up now
        module.recomputePending();

        if (submitted) {
            // the previous page in this tab really was saved, so its draft is spent
            try { await module.dropDraft(); } catch (e) {}
        } else {
            let draft = null;
            try { draft = await module.readDraft(); } catch (e) {}

            if (draft && draft.values) {
                let unsaved = Object.keys(draft.values).some(function(field) {
                    return module.valuesDiffer(draft.values[field], module.baseline[field]);
                });
                if (unsaved) module.showRestoreBar(draft);
                else if (!draft.fromAnotherTab) await module.dropDraft(); // server already has it all
            }
        }

        module.reportUnseenFields();
        module.saveDraft();
        module.setStatus();
        if (Object.keys(module.pending).length) module.scheduleFlush();
    };

    /**
     * The server says these fields are on this instrument and are saveable. If
     * the browser cannot find one, the module is silently doing nothing for it,
     * which is exactly how checkbox support was broken for three review rounds
     * behind a green test suite. Say so, loudly, in the console.
     */
    module.reportUnseenFields = function() {
        let unseen = Object.keys(cfg.fields).filter(function(f) { return module.readField(f) === null; });
        if (!unseen.length) return;
        console.warn('Auto-Save Value: ' + unseen.length + ' of ' + Object.keys(cfg.fields).length +
            ' fields declared saveable on this instrument were not found in the page, so they are NOT being ' +
            'protected. This usually means an unsupported field rendering. Please report it with this list: ',
            unseen);
    };

    // On a brand new record syncEnabled comes back false, because there is no
    // record on the server to write to. The device mirror still runs, so a reload
    // does not lose the form; the queue simply stays shut until the record exists.
    module.start();
});
