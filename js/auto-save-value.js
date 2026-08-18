/**
 * Auto-Save Value, offline layer.
 *
 * Mirrors the open form into encrypted browser storage and drips changed values
 * back to the server on a queue that survives the wifi going away.
 *
 * Two rules hold the design together. The DOM is the truth: the pending set is
 * always rebuilt from what is on screen, never bookkept, which is what makes a
 * deletion behave like any other edit. And every tab mirrors locally; only
 * sending is restricted to one tab at a time.
 */
$(function() {
    'use strict';

    // The action-tag layer already hangs save(), init() and findInput() off the
    // module object, so keep our state somewhere else and borrow only ajax().
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
     * A per-tab token, so two tabs on one record keep separate drafts.
     * sessionStorage survives a reload and a captive portal bounce but dies with
     * the tab, which is exactly the lifetime we want. Snag: opening a link in a
     * new tab copies sessionStorage, so ask around first and mint a fresh token
     * if another tab answers to this one.
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
     * Remember that a submit really happened, so a spent draft is not offered to
     * whatever the tab loads next. Cleared again after two seconds, because
     * REDCap cancels its own submit when a required field is empty.
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
     * Web Locks is ideal here: held while the promise is unresolved, released by
     * the browser when the tab dies, crash included. No heartbeat to get wrong.
     * The localStorage lease below is only for browsers that lack it.
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
                // Lost it. Stand down rather than becoming a second sender:
                // background tabs get throttled to one timer a minute, so
                // quietly losing a six second lease is routine.
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
        // no re-reading the baseline: anything typed while standing by is a
        // real change and still needs sending
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
     * One AES-GCM key per user per browser, stored as a CryptoKey rather than as
     * bytes. extractable:false means nothing can read the key back out, so
     * lifting the IndexedDB files off the tablet yields ciphertext and no key.
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
     * Chained behind any write already in flight. Two encrypts finishing out of
     * order would leave the older snapshot on disk, which is the one thing a
     * draft store must never do.
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
     * Ours first; failing that, one orphaned by a tab that died on this record.
     * Without the orphan scan, per-tab keys would make a crashed tab's work
     * unreachable, which defeats the point.
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
            // Wrong key, so this draft belongs to another user on this tablet.
            // Leave it: deleting someone else's unsaved work to tidy our own
            // screen is not a trade worth making. TTL will clear it.
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

    // field names are trusted-ish, but they still end up inside a selector
    module.sel = function(name) {
        if (window.CSS && CSS.escape) return CSS.escape(name);
        return String(name).replace(/["\\]/g, '\\$&');
    };


    /**
     * One checkbox choice, as REDCap 17 really renders it:
     *
     *   <input type=hidden   name="__chk__<field>_RC_<code>">      holds the code
     *   <input type=checkbox id="id-__chk__<field>_RC_<code>" name="__chkn__<field>">
     *
     * Note what is NOT there: nothing is named <field>___<code>. That is the name
     * saveData wants, which is a different thing entirely, and confusing the two
     * meant checkbox support silently did nothing for three review rounds.
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

    /** the choices this page actually rendered, which is not always all of them */
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
     * Radios and checkboxes need a real click, not .checked = true. REDCap keeps
     * the submitted value in a parallel hidden input that only its own handler
     * updates, so assigning the property shows the right thing and submits the
     * wrong one.
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
            // No button carries this value: a missing-data code, or one hidden
            // by @HIDECHOICE. Clear the group, or the screen keeps the old
            // answer while the stored value changes underneath it.
            module.clearRadio(field);
        }

        let input = $('[name="' + module.sel(field) + '"]').not('[type=radio]').first();
        if (!input.length || input.val() == value) return;
        input.val(value);
        module.syncAutocompleteLabel(input);
        input.trigger('change');
    };

    /**
     * Clearing a radio is not clicking one: no button has a blank value, so both
     * halves have to be undone by hand. REDCap renders a reset link,
     * radioResetVal('<field>','form'), but calling it on 17.0.3 does nothing at
     * all, tested on a live form. So ignore the link. Side benefit: with no link
     * to match, there is no way to match the wrong field's link.
     */
    module.clearRadio = function(field) {
        let group = $('input[type=radio][name="' + module.sel(field + '___radio') + '"]');
        if (!group.filter(':checked').length) return;

        group.prop('checked', false);
        let hidden = $('[name="' + module.sel(field) + '"]').not('[type=radio]').first();
        if (hidden.length) {
            hidden.val('');
            hidden.trigger('change');
        }
    };

    /**
     * Put a draft back. A recovery action must never destroy work, so anything
     * the user has touched since the page loaded is left alone.
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

            // The baseline is what REDCap rendered from the database on this
            // load. Still matching it means the box holds the old server value,
            // which is what the draft is here to replace. Different means the
            // user has typed since, and that is theirs.
            let untouchedSinceLoad = !module.valuesDiffer(live, module.baseline[field]);
            if (!untouchedSinceLoad) { skipped.push(field); return; }
            if (draftBlank && !liveBlank) { skipped.push(field); return; }
            module.writeField(field, draftValue);
        });
        module.recalculate();
        return skipped;
    };

    /**
     * An autocomplete dropdown shows its label in a separate box, which REDCap
     * gives the id rc-ac-input_<field>. Target that, not the container: two
     * autocompletes in one block would otherwise swap labels.
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
     * Joined on a space, not on nothing: ['1','23'] and ['12','3'] both collapse
     * to "123" otherwise, and two different sets of ticks compare as equal. Any
     * checkbox with ten or more choices can hit it. Mismatched shapes simply
     * differ rather than throwing.
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
     * Rebuild the pending set from the screen, every time. Nothing is ever
     * removed because we saved it; it is absent next time only if screen and
     * server now agree. That is what stops a deletion vanishing.
     */
    module.recomputePending = function() {
        let now = module.readForm();

        Object.keys(now).forEach(function(field) {
            let value = now[field];

            // they have edited a field that was in conflict. Take that as the
            // answer: their correction wins.
            if (module.conflicted[field] && module.valuesDiffer(value, module.conflicted[field].mine)) {
                module.resolveConflict(field, 'mine');
            }

            if (module.refused[field]) {
                if (!module.valuesDiffer(value, module.refused[field].value)) {
                    // still the value REDCap refused, so do not queue it and do
                    // not pretend it saved
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

        // A field that has left the page cannot be re-read. Drop it once the
        // server agrees, or it is retried forever.
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

        // fields awaiting a decision stay out, or each cycle stacks a new panel
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

        // Number every batch. A timed-out request is abandoned, not cancelled,
        // so it can still land later describing a world two edits stale. Acting
        // on that answer rolls lastKnownServer backwards.
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
                // nothing in the batch was written, so hold the queue
                module.backOff();
                return;
            }

            module.retryDelay = 0;
            // recompute rather than delete: they may have kept typing while
            // that request was in the air
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
     * A roaming tablet does not always get a refusal; sometimes it gets silence.
     * Without a timeout, busy stays true and the queue is wedged for the life of
     * the page while the pill claims to be waiting.
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

        // these outrank whatever the caller asked for
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
                // Only what the draft recorded as unsaved. The rest is a stale
                // copy of the server's values, and rewriting it would overwrite
                // somebody's later edit with a baseline that matches.
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
     * REDCap refused a value. Say so once rather than retrying it silently every
     * ten seconds; the panel clears itself when the field saves.
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

    // a panel prepended out of sight on a long form is a panel nobody reads
    module.scrollTo = function(el) {
        try { el[0].scrollIntoView({ block: 'center' }); } catch (e) {}
    };

    module.escapeHtml = function(s) {
        return $('<div></div>').text(s == null ? '' : s).html();
    };

    /* ------------------------------------------------------------------ */

    /**
     * 'change' on a text box only fires at blur, so somebody who types a
     * paragraph and walks away would be captured by nothing. Hence 'input' too,
     * debounced. Anything that looks like the page is about to die forces a save
     * rather than waiting for the timer.
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

        // Deliberately does not clear the queue. REDCap cancels its own submit
        // for required fields, and an earlier version threw away everything
        // queued when that happened. This only notes that a submit occurred.
        form.on('submit', function() { module.markSubmitted(); });
    };

    /** a refusal can be permanent or merely current; let it try again */
    module.rearm = function() {
        if (!module.stopped) return;
        module.stopped = false;
        $('.asvo-stopped').remove();
        module.setStatus();
    };

    module.start = async function() {
        // Baseline before any await. Opening IndexedDB and generating a key take
        // long enough on a tablet that anything typed in the gap would otherwise
        // be mistaken for what the server already had.
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
            console.log('Auto-Save Value: no usable device storage', err); // private browsing, most likely
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
     * If the server declared a field saveable and the browser cannot find it, the
     * module is quietly doing nothing for that field. That is how checkbox
     * support stayed broken through three review rounds behind a green suite, so
     * complain in the console rather than shrug.
     */
    module.reportUnseenFields = function() {
        let unseen = Object.keys(cfg.fields).filter(function(f) { return module.readField(f) === null; });
        if (!unseen.length) return;
        console.warn('Auto-Save Value: ' + unseen.length + ' of ' + Object.keys(cfg.fields).length +
            ' fields declared saveable on this instrument were not found in the page, so they are NOT being ' +
            'protected. This usually means an unsupported field rendering. Please report it with this list: ',
            unseen);
    };

    // On a new record syncEnabled is false: nothing on the server to write to
    // yet. The device mirror still runs, so a reload does not lose the form.
    module.start();
});
