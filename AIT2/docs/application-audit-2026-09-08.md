# Application cleanup and workflow audit — 8 September 2026

The cleanup preserves the existing appearance and business behaviour. The audit found several accessibility and multi-user problems; **none of the reported problems below was fixed**. Changes are local and have not been deployed.

The strongest positive result is the isolated costing-to-return workflow: quotation pairing, role assignment, manpower, transport, concurrent preparation, concurrent return, maintenance retries, and container packing worked in the tested scenarios. The strongest concerns are stale Transport data, independent stock-check state between users, and keyboard access/focus in the worker portal.

## Scope and method

- Inventoried 90 first-party runtime Python, JavaScript, CSS, and HTML files, totalling 6,958,481 source bytes before cleanup. Examined structure, duplicate definitions, dependencies, legacy renderers, refresh handling, permissions, and the requested workflows. This is a repository-wide structural review plus deeper review of the requested paths, not a claim that every line or possible state was manually exercised.
- Ran the complete existing Python and Node suites before and after editing. Parsed 108 tracked Python files and syntax-checked 38 JavaScript/test files after editing.
- Used the deployed app for role sign-in, navigation, populated page inspection, and form inspection. Used disposable, loopback-only fixtures for writes, lifecycle transitions, and simultaneous users. No live event, financial, inventory, maintenance, or workforce record was edited.
- Examined desktop and 390 CSS-pixel layouts, plus selected 320-pixel pages. Used DOM/accessibility-tree inspection and keyboard interaction. This was not a real-device, screen-reader, or comprehensive WCAG conformance assessment.
- Preserved the existing inventory-grouping changes in `static/js/app.js` and `tests/test_inventory_grouped_view.py` that were present before this audit.

## Cleanup performed

| Change | Reason and verification |
| --- | --- |
| Removed 318 lines of the obsolete Return implementation from `static/js/app.js` | Its six functions were only referenced inside the retired block, and its target DOM IDs had no markup owners. The active `returnPage*` workspace remains. Preparation and return were exercised through both HTTP and the browser. |
| Extracted 771 lines into `static/js/asset-check.js` | Gives stock checking one feature owner. The body, embedded styles, state, and functions were moved intact; an exact text comparison verifies this. The classic script loads immediately after `app.js`, with normal versioning. Direct page loading, scanning, refreshing, and marking missing were exercised locally. |
| Deleted five empty My Claims compatibility stylesheets and their template/version entries | All five contained only a comment pointing to `my-claims.css`. They could not affect styling. After adding the asset-check script, the page has four fewer static-resource requests overall. |
| Reduced custom-select work | Replaced repeated option-array construction/search with the option's native index, and avoided writing unchanged font, disabled, and validity attributes. Selection and keyboard navigation were checked. Existing polling and behaviour remain. |
| Updated architecture documentation and the test source-bundle helper | Documents the actual feature owner and includes the extracted script in structural tests. No test assertions were relaxed. |

The combined `app.js` plus asset-check source is 13,640 bytes smaller than the original `app.js`. Extraction improves ownership; it does not itself reduce total parsing work. No whole-app speedup is claimed from these changes.

No duplicate Python definitions within the inspected scopes or duplicate top-level JavaScript function declarations within individual files were reported by the structural scan. This does not prove the absence of cross-file globals or deliberate CSS cascade overrides. Repeated PDF drawing helpers and layered styles were left where their differing context could affect exported output or appearance. The backend remains large and needs gradual feature extraction rather than a mechanical rewrite.

## Workflow and role coverage

| Area | Evidence and result |
| --- | --- |
| Live Admin | Login succeeded. Inspected events, Add Event form, costing, linked accepted quotation, Plan, Crew & Vendors, Transport, Prepare, and Return. Costing/quotation pairing was visible. No live forms were saved. |
| Live Manager | Login succeeded. Operational pages, populated inventory, containers, maintenance, asset check, transfers, and vehicles loaded. Sales was absent under this account's configured permissions. |
| Live User | Login succeeded. Role restrictions and operational empty states were visible. My Claims contained an assigned Event 1, while operational event access did not; see the assignment distinction below. |
| Live Worker 1 | Phone lookup recognised the supplied number. The next screen required a separate PIN/password. Using the supplied numeric value as the PIN once returned “Incorrect PIN or password.” Further live worker actions remain unverified pending a valid PIN. |
| Costing → quotation → event | Disposable costing conversion preserved its inventory source and link. A stale quotation write returned HTTP 409. Acceptance created one linked event; repeat acceptance kept the same event. |
| Event assignment and planning | A manager assigned the ordinary user, who could then read the event. Linked inventory requirements carried through to preparation. Existing planning-template, availability, subproject, and schedule tests ran. |
| Manpower and transport | Manager-created crew assignment retained department, role, days, and daily rate. Transport retained route, departure time, and cost. Cross-session Transport display failed to update; details below. |
| Prepare | Simultaneous User and Manager asset assignments both persisted. In the browser, one user kept an unsaved custom-item field focused while a peer assigned another asset; progress updated to 100% and the value and focus survived. This continuity check was on desktop. |
| Return | Simultaneous returns both persisted. Closing with outstanding assets was rejected. Browser serial-number and asset-ID scanning worked; scanner focus survived. One fully returned event closed. Another correctly remained Pending Closure because workforce obligations were unfinished. |
| Inventory and containers | Populated live inventory loaded (600 records/1,172 units). Local returned assets packed into a container. Existing creation, grouping, bulk inventory, serial number, container contents, and container maintenance tests ran. |
| Maintenance | A local two-asset maintenance batch saved two logs. Repeating the request saved zero additional logs and detected two duplicates. Existing media, status, version, batch, and container-maintenance tests ran. |
| Asset Check | Group loading and sighting worked; deployed assets were excluded from in-store eligibility. Repeating one sighting did not duplicate its log. Shared progress and stale marking behaviour failed the multi-user expectation below. |
| Disposable worker portal | A configured worker signed in and saw the correct assigned event, submission slots, and mobile layout. Existing worker upload/review/replacement/payment-confirmation tests ran. Pointer uploads with real live Worker 1, real payment actions, and notification delivery were not tested. |

Other existing tests covered accounting, document handling, exports, permissions, storage isolation, Telegram integration with mocks, routing, and settings. Passing those tests is not equivalent to manually checking every screen or delivering a real external notification.

## Bugs and accessibility gaps — left unchanged

### 1. High: stock-check progress is independent between users

**Reproduced locally.** Browser A started a group check. User B sighted `AX#07` through a separate authenticated session. A still showed it as not sighted, including after the page's Refresh action. A's subsequent mark-missing request for that asset was accepted (`marked: ["AX#07"]`, no skips).

`static/js/asset-check.js:3` stores checked assets in a browser-local `Set`; `refreshAssetCheckGroup` at line 706 restores that local set. `app.py:29887` validates current group/store eligibility when marking missing but has no shared check-session revision to reconcile peer sightings.

**Effect:** two people checking the same stock group can disagree and incorrectly mark a physically sighted asset missing. This could be intentional independent-session behaviour, but the interface does not establish that distinction and it does not meet a shared stock-taking workflow.

**Proposed change:** persist an explicit stock-check session with shared sightings, subscribe clients to its changes, and atomically validate the session revision before marking missing. If checks must remain independent, identify their owners/scope clearly and reject a stale mark when a relevant newer sighting exists. Scope sightings to a session; treating every historical sighting as current would be incorrect.

### 2. High: worker invoice and claim uploads cannot be reached by keyboard

**Confirmed in the local worker UI and source.** The upload zones expose text but no keyboard-focusable file chooser. `static/js/worker.js:324` builds a label around a hidden file input; the rendered input is not focusable, and the zone has no equivalent keyboard control.

**Effect:** keyboard users cannot complete a core worker workflow, even though pointer users can click the upload area.

**Proposed change:** provide a real named button activating the file input, or a visually hidden but focusable input with a visible focus indicator. Preserve drag-and-drop as an additional interaction. This relates to [WCAG keyboard access](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html).

### 3. Medium: Transport stays stale while the application says Live

**Reproduced locally with independent admin and manager sessions.** Admin viewed one booking totalling $150. Manager created a second booking for $175. The server held both bookings, but the visible, foreground Admin page continued to show one booking/$150. A manual reload immediately showed two bookings/$325.

The server emits a workforce change for transport creation (`app.py:15884`). The event-scoped frontend handler covers the workforce section but does not refresh the Transport workspace before returning (`static/js/app.js:24697`). The visible-event refresh selection also excludes that workspace (`static/js/app.js:24345`).

**Proposed change:** handle transport-related events for the currently selected event and update the affected booking/totals only. Preserve draft fields, focus, expanded groups, selected event, and scroll. A forced full-page refresh would not satisfy the continuity requirement.

### 4. Medium: worker background updates remove keyboard focus

**Reproduced locally at 390 CSS pixels.** The worker event summary was focused and expanded. A manager changed the assignment rate in another session. After the worker's poll processed the update, focus moved to `BODY`; the event remained expanded.

`renderCompanies` (`static/js/worker.js:398`) saves open sections and window scroll, then replaces the event HTML. It does not preserve the focused control. The five-second poll invokes this rendering when the payload changes (`static/js/worker.js:812`).

**Proposed change:** patch changed cards/fields by stable identity. Where replacement is necessary, restore focus and selection to the corresponding control and avoid replacing active edits. Avoid announcing the entire card repeatedly to assistive technology.

### 5. Medium: costing list rows are pointer-only

**Confirmed on the live costing list and in source.** A row opens the costing through `onclick`, but offers no focusable link/button or keyboard activation (`static/js/costing.js:700`).

**Proposed change:** make the costing title a normal named link or button with an appropriate focus state. Keep row clicking as an optional convenience. The core action should meet [keyboard access requirements](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html).

### 6. Medium: some operational and financial fields lack explicit accessible labels

**Observed through live DOM/accessibility inspection.** Examples include Plan's generated quantity inputs (`static/js/plan.js:1787`), per-row manpower time fields, and several quotation schedule/date/amount controls. Some rely on position or placeholders rather than a programmatic relationship to their visible heading. Icon-only financial actions can expose only symbols such as a pencil, lock, or multiplication sign.

**Proposed change:** associate visible labels with the inputs; include row/item/date context where a table contains repeated fields; give icon actions descriptive accessible names. Placeholder-only descriptions are insufficient instructions for many users. Review against [labels and instructions](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html). This finding is scoped to sampled fields, not a claim that every field is unlabeled.

## Mobile and continuity observations

- The sampled operational pages fitted the 390-pixel viewport without document-level horizontal overflow. Selected pages were inspected at 320 pixels; the fully loaded Asset Check start screen fitted that width. This is useful evidence, not certification of every modal, orientation, zoom level, or populated table.
- Financial editors are denser. Observed costing controls included an approximately 14-pixel pencil action and an 18-pixel remove action. Some quotation remove controls measured roughly 10 × 15 pixels. These are touch-usability concerns. Evaluate hit-area spacing and exceptions before declaring a formal failure of the [24 × 24 CSS-pixel target-size criterion](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Increasing invisible hit padding may preserve the visual design.
- Wide financial tables used contained scrolling. Check their focus scrolling and sticky context on physical devices; the [reflow criterion](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) permits exceptions for genuinely two-dimensional content.
- Returning to Asset Check starts over: `loadAssetCheck` calls `resetAssetCheckState` (`static/js/asset-check.js:267`). The checked set is not a resumable session. This is a workflow risk when a user leaves to inspect an asset and comes back. A server session, with optional local draft persistence, is the alternative.
- The positive Prepare result shows that partial updates can preserve a user's draft and focus. Apply the same standard to Transport, stock checks, worker cards, and modal refreshes.
- The live User's My Claims assignment and operational assignment are separate. `_my_claims_payload` (`app.py:10794`) uses workforce assignments; `_current_user_can_access_event` (`app.py:1574`) checks `assigned_users`. Thus a user can see an event in claims but cannot prepare/return its assets. Confirm whether both permissions should be granted together; this is a configuration/workflow distinction, not a demonstrated authorization bypass.

## Processing and responsiveness: changes worth considering

These are source-backed candidates, not measured production CPU bottlenecks. No CPU profiler, representative load test, or mobile battery benchmark was run.

| Candidate | Why it can cost work | Alternative and trade-off |
| --- | --- | --- |
| Eagerly loaded frontend | Before cleanup, `app.js` was 1.10 MB, `finance.js` 468 KB, workforce administration 263 KB, and the main HTML 421 KB, before compression. Loading unrelated features costs transfer, parsing, and DOM work. | Continue feature extraction, then load features once on first use. Establish explicit shared dependencies first; arbitrary async loading would break classic-script globals/order. Measure cold-load and navigation latency separately. |
| All-select synchronisation every 400 ms | `custom-select.js:316` visits every enhanced select, including hidden sections; a body-wide observer also examines inserted nodes. This remains after the small redundant-write optimisation. | Replace broad polling with explicit change notifications and scoped observation of active components. Audit every programmatic value update before removing the compatibility poll. |
| Worker company polling every five seconds | Each visible worker refreshes all linked companies and compares full JSON payloads. Roughly N workers × C companies / 5 requests per second, before other requests. Any data change can rebuild all visible event cards. | Use revision/ETag checks or scoped SSE events, update only changed cards, and compute statistics only when needed. Requires careful reconnection and permission handling. |
| Overlapping worker polls | The async interval has no in-flight guard. A request taking longer than five seconds can overlap the next one; an older response could replace newer data. This is a source-level race risk, not a reproduced production failure. | Schedule the next poll after completion, or use a generation/abort guard. Retain visibility/upload safeguards and add backoff. |
| Broad modal rebuilding | Some refresh paths reconstruct modal content. Even without a browser reload, replacing nodes can lose draft state, scroll, or focus. | Review each active modal's state restoration and patch rows/fields where possible. Add a focused continuity test for real peer updates before changing it. |

Do not interpret the shorter second test-suite duration as an application speed improvement: caching and test-order/environment effects were not controlled.

## Verification and remaining limits

| Check | Before cleanup | After cleanup |
| --- | --- | --- |
| Python suite | 998 passed, 4 failed, 8 skipped | 998 passed, same 4 failed, 8 skipped |
| Node suite | 79 passed | 79 passed |
| Syntax checks | Structural inventory parsed runtime Python | 108 Python files parsed; 38 JavaScript/test files passed `node --check` |
| Extraction integrity | Original source backed up | Asset Check body matches exactly; `app.js` differs from that backup only by the two intended block removals |

The four baseline failures were left unchanged:

1. `test_event_menus_are_portaled_clamped_and_restored` expects the literal direct `getBoundingClientRect()` assignment; implementation uses the viewport scaling helper. This is a structural assertion mismatch, not evidence from this test alone of broken positioning.
2. `test_freelancer_history_includes_event_and_submission_statuses` expects AVPL branding but receives SHOWBASE in the isolated configuration.
3. `test_worker_first_access_requires_credentials` has the same branding expectation mismatch.
4. `test_worker_upload_queues_telegram_notification` expects company code AVPL but receives SHOWBASE in the isolated configuration.

The eight skipped tests require `TEST_DATABASE_URL` for PostgreSQL integration. Concurrent requests passed against the disposable storage setup; multi-process PostgreSQL behaviour is not certified. Production notification delivery, hardware scanner/camera behaviour, every export layout, large-file upload resilience, physical mobile browsers, and assistive-technology announcements need further environment-specific checks.

Local audit evidence is retained under `tmp/audit-20260908/evidence/`: baseline/final Python and Node logs, workflow results, structural inventory, and preview log. Disposable scripts are under `tmp/audit-20260908/tools/`. These directories are ignored by Git and are not application assets. The audit report and source changes are reviewable independently of that local evidence.

**Next priority:** resolve the shared stock-check semantics and keyboard upload access first, then Transport updates and worker focus preservation. These are recommendations only; the requested no-bug-fix boundary was maintained.
