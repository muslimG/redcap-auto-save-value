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
It mirrors the whole form into encrypted browser storage, and sends changed
fields to the server on a queue that survives the connection going away.

The two layers do not interfere with each other. A field may be covered by both.

********************************************************************************
## What layer two adds

| | Action tags | Offline layer |
|---|---|---|
| Chosen by | `@AUTOSAVE` on a field | instrument, in the config |
| Data entry forms | yes | yes |
| Surveys | yes | no |
| Saves while offline | no, the save is lost | yes, queued and retried |
| Copy of the form on the device | no | yes, encrypted |
| Checkbox fields | no | yes |
| Detects someone else's edit | no | yes |
| Authorisation re-checked server side | inherits REDCap's | form rights, DAG, locking, e-signature |

**On the device.** Every change is mirrored into IndexedDB, encrypted, about half
a second after the typing stops. If the page reloads, redirects or crashes, the
next time the form is opened the user is offered a one-click restore.

**To the server.** Changed fields are batched and sent every ten seconds or so
through the same external module AJAX channel, calling `REDCap::saveData()`. When
the network is away the batch stays queued and is retried with exponential
backoff, and immediately when the browser reports it is back online.

**Conflict handling.** Each queued change carries the value the browser last
believed the server held. If the server disagrees, someone edited the record
while the change sat in the queue, so that field is refused and both values are
handed back for the user to choose between. The rest of the batch still saves.
The user can keep theirs, keep the other, or simply correct the field.

**Two tabs on one record.** Every tab mirrors to the device and keeps its own
draft, so nothing typed anywhere is lost. Only one tab at a time is allowed to
send, chosen with the Web Locks API, which the browser releases automatically
when that tab closes or crashes. On a browser without Web Locks there is a
localStorage lease that stands down when it loses the record.

**When something is not right.** If the browser cannot find a field the server
declared saveable, it says so by name in the console at startup.

**A status indicator** in the corner says which state you are in: all saved,
holding changes on the device, another tab is saving, a value was not accepted, a
change needs your decision, or the backup itself has failed.

### Authorisation, and why layer two is not on surveys

`REDCap::saveData()` is an API level write and enforces none of the protections
the data entry screen gives you automatically, so the offline endpoint re-checks all
of them itself, on every request rather than once at page load:

| Check | How |
|---|---|
| Instrument opted in | project setting, and nothing happens until one is chosen |
| Form-level rights | `REDCap::getUserRights()`, edit rights only |
| Data access group | `Records::getRecordGroupId()`, then `getData` with `exportDataAccessGroups` |
| Event | must be an event this project has, with this instrument designated |
| Record locking | `redcap_locking_data`, with the schema read from the database rather than assumed |
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
| Instrument to protect | none | Repeatable. **Empty means the offline layer does nothing** |
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

Checkbox fields **are** supported here. Still not written: calculated fields,
which the server recalculates itself, file and signature fields, ontology
lookups, sliders and rich text, the record ID and the form completion status.
`[form]_complete` is deliberately never written, so a form stays Incomplete until
a user genuinely saves it.

Two further gaps:

- Fields populated by `@DEFAULT` or `@SETVALUE` are already on screen when the
  page loads, so the offline layer reads them as values the server already has
  and never sends them. The action-tag layer handles this case properly; if it
  matters to you, tag those fields.
- Up to about six tenths of a second of typing can be lost if the page dies
  before the debounce fires. The save attempted on `pagehide` is best effort and
  usually does not complete, because browsers do not wait for IndexedDB during
  unload.


********************************************************************************
## Installing

**The easy way.** Download `auto_save_value_v2.0.0.zip` from the
[Releases](https://github.com/muslimG/redcap-auto-save-value/releases) page, then
in REDCap go to Control Center, External Modules, and upload it. The folder inside
that zip is already named the way REDCap needs, so there is nothing to rename.


