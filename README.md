********************************************************************************
# Auto-Save Value

Syed Gilani, The Kids Research Institute Australia https://www.thekids.org.au

[https://github.com/muslimG/redcap-auto-save-value/](https://github.com/muslimG/redcap-auto-save-value/)

Adapted from the original by Luke Stevens, Murdoch Children's Research Institute
[https://github.com/lsgs/redcap-auto-save-value/](https://github.com/lsgs/redcap-auto-save-value/)

********************************************************************************
## Summary

This is a fork of Luke Stevens' Auto-Save Value. Everything the original module
does, it still does, and that half of the code is his. What this fork adds is a
second, optional layer for data entry forms on tablets that lose their network
mid form.

**Layer one, the action tags. Luke Stevens' work, unchanged.**
Tag a field and its value is saved on its own the moment it changes, on data
entry forms and on surveys.

- `@AUTOSAVE` Auto-save the field's value when it is updated (in either data entry or survey mode).
- `@AUTOSAVE-FORM` Auto-save in data entry mode only, not in survey mode.
- `@AUTOSAVE-SURVEY` Auto-save in survey mode only, not in data entry mode.
- `@AUTOSAVE-FORM-HIDEICON` As `@AUTOSAVE-FORM`, but suppress the field's save icon where in data entry mode it would normally be shown.
- `@AUTOSAVE-SURVEY-SHOWICON` As `@AUTOSAVE-SURVEY`, but show the field's save icon where in survey mode it would normally be suppressed.

**Layer two, the offline layer. New in this fork.**
Switched on per instrument in the module configuration rather than per field.
On data entry forms it mirrors the whole form into encrypted browser storage and
sends changed fields to the server on a queue that survives the connection going
away. On survey pages it does the first half only: the page is held on the device
and offered back if the page reloads.

The two layers do not interfere with each other. A field may be covered by both.

********************************************************************************
## What layer two adds

| | Action tags | Offline layer |
|---|---|---|
| Chosen by | `@AUTOSAVE` on a field | instrument, in the config |
| Data entry forms | yes | yes |
| Surveys | yes | held on the device and offered back after a reload; nothing sent |
| Saves while offline | no, the save is lost | yes, queued and retried |
| Copy of the form on the device | no | yes, encrypted |
| Checkbox fields | no | yes |
| Detects someone else's edit | no | yes |
| Authorisation re-checked server side | inherits REDCap's | form rights, DAG, locking, e-signature |

**On the device.** Every change is mirrored into IndexedDB, encrypted, about half
a second after the typing stops. If the page reloads, redirects or crashes, the
next time the form is opened a banner above the form offers to put the unsaved
answers back. The offer stays, reload after reload, until the user puts them back
or presses Discard; it also gathers up work left behind by other tabs on the same
record that are no longer open. Answers that are still not on the server expire
with the draft TTL.

**To the server.** Changed fields are batched and sent every ten seconds or so
through the same external module AJAX channel, calling `REDCap::saveData()`. When
the network is away the batch stays queued and is retried with exponential
backoff, and immediately when the browser reports it is back online.

**Conflict handling.** Each queued change carries the value the browser last
believed the server held. If the server disagrees, someone edited the record
while the change sat in the queue, so that field is refused and both values are
handed back for the user to choose between. The rest of the batch still saves.
The user can keep theirs, keep the other, or simply correct the field. The same
check runs when a recovered draft is put back: a field a colleague changed in the
meantime is shown as a choice, not written over.

**Two tabs on one record.** Every tab mirrors to the device and keeps its own
draft, so nothing typed anywhere is lost. Only one tab at a time is allowed to
send, chosen with the Web Locks API, which the browser releases automatically
when that tab closes or crashes. On a browser without Web Locks there is a
localStorage lease that stands down when it loses the record.

**When something is not right.** The browser console gets one line at startup
saying how many fields are covered and whether background saving is on. If it is
off, the line says why (no edit rights, another data access group, a locked form,
a record that does not exist yet). Fields on the instrument that are not covered
are listed with the reason, and a field the server declared saveable but the page
does not contain is named. `AutoSaveOffline.diagnose()` in the console returns
the whole state as one object.

**A status indicator** in the corner says which state you are in: all saved,
holding changes on the device, another tab has the connection, a value was not
accepted, a change needs your decision, unsaved answers are being offered above,
or the backup itself has failed. Hovering it gives the reason when saving is off.
On a record that has not been created yet, and on a page the user could not save
by hand, the indicator stays grey: the form is mirrored to the device but nothing
is sent.

### Surveys

The failure this exists for happens on surveys too: a parent is on page three of
a questionnaire on a tablet, the tablet roams to another access point as the RA
walks, Next is pressed, and the page comes back empty. The offline layer covers
survey pages of every protected instrument, with two differences from data entry.

Nothing is sent in the background. A survey respondent is not a logged-in REDCap
user, so none of the checks the endpoint relies on mean anything, and the `sync`
action is never reachable from a survey. The page is held on the device as the
respondent types, and if the page reloads, whether from a network error, a
refresh or a browser crash, the banner offers the answers back. Pressing Next
then saves them exactly as it would have.

There is no status indicator on a survey. The banner is the whole interface.

Each page of a multi-page survey is held separately, keyed by the record and the
page number, so page two is never offered page one's answers. Once a later page
has loaded with a saved response, the earlier pages' rows have done their job and
are removed, and the acknowledgement page at the end clears the respondent's rows
from the device. A survey that ends by redirecting elsewhere skips the
acknowledgement page, so its last page's row stays until the TTL; it is keyed by
that respondent's record, so nobody else is offered it.

**On a shared tablet, be aware:** the first page of a public survey has no record
yet. If a respondent types on it and walks away without ever pressing Next, the
next person to open that same public survey page on that tablet within the TTL
will see the banner, and could put the previous person's answers back. The
banner says how long ago they were typed, and Discard throws them away. If your
public surveys collect anything sensitive on page one and the tablets are
shared, set the TTL short, or protect only the instruments where this trade is
worth it. Surveys opened from a participant's own link, or by an RA from the
record, carry the record from the first page and are not affected.

### Authorisation, and why the endpoint is not on surveys

`REDCap::saveData()` is an API level write and enforces none of the protections
the data entry screen gives you automatically, so the offline endpoint re-checks all
of them itself, on every request rather than once at page load:

| Check | How |
|---|---|
| Instrument opted in | project setting, and nothing happens until one is chosen |
| Form-level rights | `REDCap::getUserRights()`, judged with REDCap's own `UserRights::hasDataViewingRights()`, which understands both the old 0 to 3 values and the bitmask REDCap 16 uses; a completed survey response also needs "edit survey responses". Administrators not on the project are treated as REDCap treats them |
| Data access group | `Records::getRecordGroupId()`, then `getData` with `exportDataAccessGroups` |
| Event | must be an event this project has, with this instrument designated |
| Event and instance | the event must carry this instrument; an instance number on a form that does not repeat is ignored, and on a classic project the event is the project's only one, so neither can be used to aim past a lock |
| Record locking | `redcap_locking_data` for the form and `redcap_locking_records` for the whole record, with the schema read from the database rather than assumed |
| E-signature | `redcap_esignatures`, likewise |

The username comes from `USERID`, not from the request. That is exactly why the
offline layer is not offered on surveys: a survey respondent is not a REDCap user
and has no `USERID`, so none of those checks mean anything there. The `sync`
action is declared in `auth-ajax-actions` only. The action-tag layer keeps its own survey path exactly as
Luke Stevens wrote it.

### On-device encryption

Drafts are encrypted with AES-GCM using a key generated by the Web Crypto API
with `extractable: false`. The browser holds the key material internally and
there is no API that can read the bytes back out, so the key never exists on disk
in a usable form.

Keys and drafts are namespaced per REDCap username, and drafts expire after a
configurable TTL, twelve hours by default.

********************************************************************************
## Configuration

The action tags need no configuration. Everything in the module configuration
dialog belongs to the offline layer.

| Setting | Default | Notes |
|---|---|---|
| Protect | none | **All instruments** (including ones added later) or **only those listed below**. Until one is chosen the offline layer does nothing. Applies to data entry forms and survey pages alike |
| Instrument | none | Repeatable. Shown when "only those listed below" is chosen. **Empty means the offline layer does nothing** |
| Seconds between background saves | 10 | Minimum 3 |
| Discard on-device drafts older than | 12 hours | Range 1 to 168 |
| Hide the sync status indicator | off | |
| Text for "reason for change" | `auto_save_value` | Shown only where the project requires a reason. Used by both layers |

Start with one instrument and test it, then add more forms.

### "Require Reason for Change" Option

Unchanged from the original, and it now covers both layers. Auto-saving on data
entry forms does **\*not\*** trigger the "Require reason for change" dialog box
when this option is enabled in a project. Instead a default text value of
"auto_save_value" is recorded as the reason for change. There are two options for
customising this text:

1. When the "Require reason for change" option is enabled in the project, the
   Module Configuration settings dialog shows an option where the desired default
   value may be entered.
2. The default text is written into a hidden HTML element in the page:
   `<span id="AutoSaveReason" class="d-none">auto_save_value</span>`. Updating the
   text content of this element using a client-side script will have the altered
   text submitted as the "reason for change" instead.

Neither layer can stop and ask a user for a reason. If a single repeated string
is not acceptable for your audit trail, do not enable this module on that
project.

********************************************************************************
## Limitations

### Action tags (original project)

The following field types are still **\*not supported\***:
- Text fields with ontology lookup
- Calculated fields (including text fields with `@CALCDATE()` and `@CALCTEXT()`)
- Checkbox
- File upload
- Signature
- Slider

Auto-save cannot occur until the record exists for values to be saved to. This
means auto-save cannot work on the first page of a public survey, or when
creating a new record. The tags do not operate in Draft Preview mode, or when
previewing an instrument in the Online Designer.

### Offline layer

Checkbox fields **are** supported here, as are radio, yes/no, true/false,
dropdown (including autocomplete and SQL), text in every validation, notes,
and matrix rows. Still not written: calculated fields, which the server
recalculates itself, file and signature fields, ontology lookups, sliders, rich
text, the randomisation field, the record ID and the form completion status.
`[form]_complete` is deliberately never written, so a form stays Incomplete until
a user genuinely saves it. Fields that are read-only on the page (`@READONLY`,
`@READONLY-FORM`, evaluated per record when inside `@IF`) are not mirrored,
because REDCap drives them. The console lists every uncovered field on the
instrument with its reason.

Values REDCap pre-fills with `@DEFAULT`, `@SETVALUE`, `@TODAY` or `@NOW` are
saved by the offline layer as REDCap itself would save them on Save, because the
page is told what the database actually holds rather than guessing it from the
screen.

Two further gaps:

- Up to about six tenths of a second of typing can be lost if the page dies
  before the debounce fires. The save attempted on `pagehide` is best effort and
  usually does not complete, because browsers do not wait for IndexedDB during
  unload.
- The data entry form validates softly and still saves on Submit; the background
  save goes through `REDCap::saveData()`, which validates hard. A value the form
  would have accepted with a warning can therefore be refused in the background.
  The refusal is shown above the form, the value stays on screen and in the draft,
  and nothing else is held up.


********************************************************************************
## Installing

**The easy way.** Download `auto_save_value_v2.2.1.zip` from the
[Releases](https://github.com/muslimG/redcap-auto-save-value/releases) page, then
in REDCap go to Control Center, External Modules, and upload it. The folder inside
that zip is already named the way REDCap needs, so there is nothing to rename.



**From a clone.** REDCap reads a module's version from its **directory name**,
which must be `<prefix>_v<version>`, so a clone has to be copied into
`redcap/modules/` as `auto_save_value_v2.2.1`. Only the module's own files belong
there: `AutoSaveValue.php`, `config.json`, `README.md`, `LICENSE`, `css/` and
`js/`.

**Updating.** Put the new version's directory alongside the old one, then in
Control Center, External Modules, pick the new version for the module. REDCap
keeps every project's settings across versions. The new "which instruments to
protect" setting is empty on an updated project until an administrator opens the
module configuration and chooses; the previous per-instrument list keeps working
untouched in the meantime.

## Changes

**2.2.1**
- A request that never answers (a wifi black hole rather than a refusal) no
  longer wedges the External Module framework's shared request queue for the
  life of the page. The module's own timeout already released its state; the
  queue underneath did not move, so nothing left the browser again until a
  reload.
- A new record's first form is mirrored under "new record" because it has no id
  yet. Once the same tab is looking at a saved record, that row is retired, so
  the next new record on the tablet is not offered the last one's answers. Rows
  left by a tab that closed before saving are kept, and REDCap's record home
  page tidies the same rows when a save lands there.
- A value REDCap ends up holding anyway (an identically-valued edit landing after
  a late request) is reported as saved rather than as a conflict.
- Refusals are worded plainly ("This is not a valid date.") instead of in
  REDCap's import voice; the full text still goes to the project log.
- Panels name fields by their label, not their variable name.
- Forms with nothing coverable (descriptive text only) get no indicator.
- Matrix radio buttons (`mtxopt-` ids) are restored like any other radio.
- Once everything typed has reached the server, REDCap's "Leave site?" prompt is
  lowered; it comes back on the next keystroke, and stays if the form status
  dropdown was changed.

**2.2.0**
- Survey pages are covered: held on the device, offered back after a reload,
  nothing sent. See "Surveys" above.
- Form-level rights as REDCap 16 encodes them (a bitmask from 128; 130 is view
  and edit). Every user on such a server was being refused.
- The target field of every randomisation model is excluded, with the right
  argument order to REDCap's helper.
- Shorter labels on the configuration page.

**2.1.0**
- Plain radio fields inside a conditional `@READONLY` (`@IF(..., @READONLY, ...)`)
  were excluded for every record because the tag was matched in the raw
  annotation. It is now resolved per record, as REDCap does.
- The restore offer is persistent until answered, gathers work left by tabs that
  are no longer open, and sits above the question table at its width.
- Background saving being off is explained in the console and on the indicator.
- "Which instruments to protect": all, or only the listed ones.
- The page is told what the database holds, so `@DEFAULT` values are saved
  rather than mistaken for saved, and a first edit no longer raises a false
  conflict.
- Whole-record locks are honoured; a made-up instance or event number can no
  longer be aimed past a form lock; a completed survey response needs "edit
  survey responses"; administrators not on the project are allowed, as REDCap
  allows them.
- A colleague's later edit is never overwritten by a restore; it is offered as a
  choice.
