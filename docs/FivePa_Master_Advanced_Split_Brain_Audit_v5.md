# FivePa Master Advanced Split-Brain Audit — Version 5 (Full Consolidation + New Source Pass)

**Target ZIP:** `fivepa-freelance-marketplace (4)(1).zip`  
**SHA-256:** `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`  
**Audit date:** 24 October 2026  
**Archive file entries:** 271 (directory entries excluded)  
**Canonical numbered findings:** 56 (SB-01 through SB-56; v4's SB-01 through SB-49 retained and seven additional findings added)  
**File paths assigned at least one finding:** 120 of 271 (evidence-mapping count, not a count of defective files).

## Executive verdict

**RELEASE RECOMMENDATION: HOLD.** This v5 combines the prior audit reports and adds a new targeted source pass. It identifies additional file-sharing access failures, error-handling gaps, session-policy drift, a race condition in username uniqueness, disconnected admin operational screens, nonfunctional user management wiring, and a client-only impersonation model. The report preserves a strict distinction between source-confirmed inconsistencies, race-/outage-conditional risks, and behaviors that have not been reproduced dynamically.

## Source identity and reproducibility boundaries

The latest uploaded ZIP is available in the working session. Its SHA-256 is `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302` and the archive contains 271 file entries. The hash matches the ZIP identity recorded in earlier report versions, so the new findings are additional inspection of the same source snapshot, not evidence of a source-code change between those two ZIP filenames. The file-level matrix and inventory are generated directly against those 271 archive paths.

The prior v4 master report is appended verbatim below, retaining the older baseline, historical reports, prior findings SB-01 through SB-49, source inventory narrative, and earlier verification boundaries. **Current canonical unique finding IDs are SB-01 through SB-56.** Any stale count or summary inside a preserved historical appendix is retained only as historical text and is superseded by this v5 cover and the v5 matrix. Repeated historical IDs are not counted again as new findings.

This pass does not alter application source files. It does not claim a complete live production certification. Browser flows, real payment-provider behavior, PostgreSQL fault recovery, and concurrency races need dynamic integration tests. The earlier environment limitations remain: `npm test` is not configured in `package.json`; earlier command attempts reported `vite: not found` for build and missing `vite/client` typings for lint because dependencies were absent. Those failures do not prove the code fails after a successful, clean dependency install.

## New findings added in v5 (SB-50 through SB-56)

### SB-50 — HIGH — WorkStream uploads are not scoped to an order/workspace, so recipients can be denied access to the very files shared with them

**Verification status:** Confirmed statically; recipient-denial path follows from source; not reproduced in a running browser/backend.  
**Confidence:** High for contract mismatch and authorization path; exact user-facing outcome should be confirmed in integration test.

**Affected files and exact source locations**

- `src/utils/workstreamUpload.ts:12–29` — `uploadWorkstreamFile(file)` sends `POST /api/workstream/upload?name=...` without `orderId` or `workspaceId`.
- `src/components/workstream/WorkstreamFilesTab.tsx:20–27`, `src/components/workstream/WorkstreamMessageInput.tsx:129–149`, and `src/components/workstream/WorkstreamDeliverModal.tsx:48–63` — all invoke the helper with only a file argument.
- `server/routes/workstreamRoutes.ts:248–284` — scope IDs are optional and the upload record stores them as `undefined` when omitted.
- `server/routes/workstreamRoutes.ts:304–314` — download route enforces `canAccessWorkstreamFile`.
- `server/services/workstreamService.ts:193–225` — access succeeds for staff, file owner, or buyer/seller resolved through the stored order/workspace association; the recipient is not discoverable from a record lacking those IDs.

**Split-brain description**

The client upload contract omits the transaction/workspace context, while the server permission model requires that context to share a file with the other participant. An uploaded URL can be shown in a message or delivery but its recipient can fail the download authorization check. This can break message attachments, invoice attachments and final-delivery files.

**Reproduction / falsification scenario**

As a seller, upload a file from WorkStream Files, Message attachment, Invoice attachment, or Deliver. Inspect the POST URL and upload record for missing order_id/workspace_id. Authenticate as the buyer and request the returned `/api/workstream/files/:filename` URL. Expected product behavior is a successful participant download; source predicts 403 unless another path re-associates the record (no such association was found in the reviewed call paths).

**Minimal safe correction**

Pass the active orderId and workspaceId into the upload helper on every call; validate the two IDs refer to the same order/workspace and that the uploader is a participant; persist the association before returning the shared URL. Prefer attaching upload records atomically to the message/delivery record.

**File-level issue IDs**

- `src/utils/workstreamUpload.ts` — Upload URL sends only name; orderId/workspaceId are omitted.
- `src/components/workstream/WorkstreamFilesTab.tsx` — Calls upload helper with only the file.
- `src/components/workstream/WorkstreamMessageInput.tsx` — Message and invoice attachment uploads call helper with only the file.
- `src/components/workstream/WorkstreamDeliverModal.tsx` — Delivery upload calls helper with only the file.
- `server/routes/workstreamRoutes.ts` — Server accepts missing scope IDs and persists undefined orderId/workspaceId; download requires access check.
- `server/services/workstreamService.ts` — File access relies on owner or participant match through stored orderId/workspaceId.

---

### SB-51 — MEDIUM — Global async token middleware has no rejection forwarding for the database lookup under Express 4

**Verification status:** Confirmed statically; DB outage/runtime rejection not reproduced.  
**Confidence:** High for missing rejection handling; impact conditional on `store.getUser` rejecting while a valid token is presented.

**Affected files and exact source locations**

- `server/routes/index.ts:15–28` — `apiRouter.use(verifyAuthTokenMiddleware)` runs before the API routers.
- `server/middleware/auth.ts:102–139` — async middleware awaits `store.getUser(payload.id)` at line 108 without a surrounding `try/catch` or `next(err)` on rejection.
- `package.json:19` — dependency is `express: ^4.21.2`; Express 4 does not automatically forward rejected async middleware promises as Express 5 does.

**Split-brain description**

If a correctly signed unexpired Bearer token is presented while `store.getUser()` rejects (for example, a transient PostgreSQL failure), the middleware Promise rejects without calling `next(err)` or sending a response. That can become an unhandled rejection and leave the request unresolved, depending on process/runtime handling.

**Reproduction / falsification scenario**

In a controlled integration test, issue a request with a valid token while stubbing `store.getUser` to reject. Assert an error response reaches the standard error handler, no unhandled rejection is emitted, and the request terminates within a bounded timeout.

**Minimal safe correction**

Wrap the middleware body in `try/catch` and forward with `next(err)`; ensure an Express error handler sends a consistent 5xx. Add a regression test for database failure. An async wrapper or Express 5 upgrade is an alternative, but test all routes before switching major versions.

**File-level issue IDs**

- `server/routes/index.ts` — Mounts the async auth middleware globally before API routes.
- `server/middleware/auth.ts` — Awaited database lookup is outside a try/catch and errors are not passed to next(err).
- `package.json` — Uses Express 4.21.2.

---

### SB-52 — HIGH — Configured 60-minute session timeout is never consumed; tokens default to seven-day expiry

**Verification status:** Confirmed statically; no session-expiry integration test run.  
**Confidence:** High for configured-vs-implemented TTL mismatch.

**Affected files and exact source locations**

- `src/server/siteSettings.ts:90–98, 203–211` — security settings expose `sessionTimeoutMinutes: 60`.
- `server/middleware/auth.ts:67–75` — `signToken` uses a default `expiresInMs = 7 * 24 * 3600 * 1000`.
- `server/routes/authRoutes.ts:144, 323` and `server/services/authService.ts:243` — token creation calls `signToken(...)` without an explicit expiry override.
- Repository-wide source search found no consumer of `sessionTimeoutMinutes` outside the settings declaration.

**Split-brain description**

The settings model claims a configurable 60-minute session timeout, but tokens created by the current auth paths expire after seven days by default. There is no discovered enforcement of the 60-minute setting. If operators rely on that security control, the effective session duration contradicts their configuration.

**Reproduction / falsification scenario**

Set sessionTimeoutMinutes to a short value (for example 1–2 minutes), log in, and verify the token remains accepted after the configured timeout but before the seven-day expiry, unless another independently enforced invalidation condition intervenes.

**Minimal safe correction**

Define whether the policy means absolute lifetime or inactivity timeout. Enforce it on the server using persisted session-issued/last-activity metadata and a configurable expiry; do not rely only on a client-side setting. Add tests for exact expiration boundaries and logout/revocation.

**File-level issue IDs**

- `src/server/siteSettings.ts` — Declares sessionTimeoutMinutes=60 and other security options.
- `server/middleware/auth.ts` — signToken default TTL is seven days.
- `server/routes/authRoutes.ts` — Signup and login call signToken without overriding token TTL.
- `server/services/authService.ts` — Auth service also calls signToken without overriding token TTL.

---

### SB-53 — MEDIUM — Username uniqueness is check-then-write with no matching database uniqueness constraint

**Verification status:** Race-conditional risk confirmed statically; concurrent duplicate creation not dynamically reproduced.  
**Confidence:** High for missing DB invariant; concurrent collision needs a race test.

**Affected files and exact source locations**

- `server/routes/userRoutes.ts:69–80` — performs `SELECT ... WHERE LOWER(username)=LOWER($1)` and then separately calls `store.saveUser(user)`.
- `server/db/migration.sql:4–33` — `users.username VARCHAR(128)` is not unique; the migration has no unique functional index on `LOWER(username)`.
- `server/store.ts:399` — `saveUser` is a separate operation from the route precheck.

**Split-brain description**

Two concurrent profile updates can both observe no matching username, then both persist the same normalized username. App-level prechecks cannot enforce uniqueness under concurrency. Duplicates can cause ambiguous public profile links/search and identity confusion.

**Reproduction / falsification scenario**

Send two authenticated profile-update requests concurrently for different users with a previously unused username differing only in case. Repeat enough times under a controlled barrier so both SELECTs occur before either write; inspect rows for duplicate normalized usernames.

**Minimal safe correction**

Normalize usernames consistently and add a database unique index (e.g. a partial unique index on `LOWER(username)` for non-empty values after cleaning pre-existing collisions). Catch PostgreSQL `23505` and return 409. Keep the precheck only for friendly UX.

**File-level issue IDs**

- `server/routes/userRoutes.ts` — Checks lowercase username uniqueness and then saves user in a separate operation.
- `server/db/migration.sql` — users.username has no UNIQUE constraint or unique index on LOWER(username).
- `server/store.ts` — saveUser performs the persistence write after the route-level precheck.

---

### SB-54 — HIGH — Multiple Admin tabs are disconnected local-state demos despite available backend operations

**Verification status:** Confirmed statically by parent prop wiring and child action paths; browser interaction not reproduced.  
**Confidence:** High for the components rendered without data/callbacks and local-only handlers.

**Affected files and exact source locations**

- `src/pages/AdminPage.tsx:453–520` — `<AdminProposalsModule />`, `<AdminContractsModule />`, `<AdminDisputesModule />`, `<AdminRefundsModule />`, `<AdminPayoutsModule />`, `<AdminReviewsModule />`, `<AdminMessagesModule />`, `<AdminReportsModule />`, and `<AdminSupportModule />` are rendered without data/action props; `<AdminEscrowModule escrowAccounts={orders} />` receives no release/refund callbacks.
- `src/components/admin_modules/AdminProposalsModule.tsx:20–32, 83–95`; `AdminContractsModule.tsx:41–49, 98–135`; `AdminEscrowModule.tsx:78–98`; `AdminDisputesModule.tsx:10–20, 77–95`; `AdminRefundsModule.tsx:9–21, 82–95`; `AdminPayoutsModule.tsx:9–21, 83–104`; `AdminReviewsModule.tsx:18–46, 102–133`; `AdminMessagesModule.tsx:53–70, 113–164`; `AdminReportsModule.tsx:24–46, 95–140`; `AdminSupportModule.tsx:9–21, 80–112` — child modules default to empty arrays and primarily update `useState`; callbacks are optional.
- The reviewed admin-tab modules contain no `fetch`/Axios call to load their operational records or persist those actions. `server/routes/financialRoutes.ts` and `server/routes/adminRoutes.ts` contain relevant API handlers, but these tabs do not invoke them.

**Split-brain description**

The UI can display empty queues or show optimistic “success” messages after changing in-memory rows, without calling a backend action. For release, refund, payout, dispute resolution and support moderation, the UI status can therefore diverge from the durable ledger and records. This is a functional split-brain, not proof that money was actually transferred; the danger is an operator seeing a false confirmation.

**Reproduction / falsification scenario**

Open each named Admin tab with a clean browser and observe whether it fetches records. On Escrow, Refunds, Payouts, Disputes, Contracts, Proposals, Reviews, Messages, Reports and Support, perform an action, reload, and compare the API/database record. The source predicts local changes are lost and no matching API call is made.

**Minimal safe correction**

Wire each tab to live, role-protected list/detail APIs and action mutations. Show success only after the server returns success; surface errors and refresh from the backend. For escrow/payout/refund, use idempotent transactional endpoints and require a durable audit entry. Remove unused tabs/actions or label them as non-operational mockups until connected.

**File-level issue IDs**

- `src/pages/AdminPage.tsx` — Renders proposal/contract/dispute/refund/payout/review/message/report/support tabs without required data or action callbacks.
- `src/components/admin_modules/AdminProposalsModule.tsx` — Defaults to empty array; changes only local state unless optional callbacks are supplied.
- `src/components/admin_modules/AdminContractsModule.tsx` — Initial contracts default to empty and lifecycle actions only mutate component state.
- `src/components/admin_modules/AdminEscrowModule.tsx` — Shows release/refund success after local changes; callback props are omitted by parent.
- `src/components/admin_modules/AdminDisputesModule.tsx` — Empty default data and optional resolution callback omitted.
- `src/components/admin_modules/AdminRefundsModule.tsx` — Empty default data and optional refund callbacks omitted.
- `src/components/admin_modules/AdminPayoutsModule.tsx` — Empty default data; approve/process/reject modifies local state and shows success toast.
- `src/components/admin_modules/AdminReviewsModule.tsx` — Empty initial data; moderation and deletion local-only when callbacks absent.
- `src/components/admin_modules/AdminMessagesModule.tsx` — Empty initial threads and optional moderation callback omitted.
- `src/components/admin_modules/AdminReportsModule.tsx` — Empty initial reports and optional report-action callbacks omitted.
- `src/components/admin_modules/AdminSupportModule.tsx` — Empty initial tickets and optional reply/status callbacks omitted.
- `server/routes/financialRoutes.ts` — Backend financial endpoints exist but are not called by the above modules.
- `server/routes/adminRoutes.ts` — Backend admin endpoints exist but are not called by the above modules.

---

### SB-55 — HIGH — Admin User Management is passed an empty users list and no-op setter; edits/status changes do not reach durable backend state

**Verification status:** Confirmed statically; no browser test run.  
**Confidence:** High: App renders this path with explicit empty/no-op props.

**Affected files and exact source locations**

- `src/App.tsx:104–120` — passes `usersList={[]}` and `setUsersList={() => {}}` to `AdminPage`.
- `src/pages/AdminPage.tsx:412–423` — gives `usersList` to `AdminUsersModule`; toggle callback only mutates the supplied state setter.
- `src/components/admin_modules/AdminUsersModule.tsx:11–29, 80–121` — `onUpdateUser`/`onDeleteUser` are optional; edit/status/delete flows update local React or localStorage state and only call optional handlers if supplied. Parent does not supply update/delete handlers.
- `server/routes/adminRoutes.ts:762–876, 948–989` — backend update/status/delete routes exist but this component does not call them.

**Split-brain description**

The actual `App` integration passes an always-empty list and a no-op setter, so the User Management tab has no durable source of user rows in the inspected UI path. Even if users are later injected, update and delete callbacks are omitted, and the only status callback changes frontend state. Its local restricted/active toggle can also disagree with the parent suspended/active mapping.

**Reproduction / falsification scenario**

Navigate to `/admin` through the real App, open User Management, and inspect its user list. If rows are supplied by a future workaround, edit a role/email/wallet field or suspend a user then reload and query `/api/admin/users/:id`; no request is sent from this module and durable state remains unchanged.

**Minimal safe correction**

Load users through an authenticated admin API and pass real records. Implement update/status/delete handlers that call the backend endpoints, await success, refresh from server, and align status enums. Never allow a client-only wallet balance edit; route any legitimate wallet adjustment through an audited ledger operation.

**File-level issue IDs**

- `src/App.tsx` — Passes usersList as an empty array and setUsersList as a no-op function into AdminPage.
- `src/pages/AdminPage.tsx` — Renders AdminUsersModule with usersList and passes a local-state status toggle only.
- `src/components/admin_modules/AdminUsersModule.tsx` — Edits/deletes/toggles local state; update/delete API callbacks are optional and not supplied.
- `server/routes/adminRoutes.ts` — Has real admin user update/status/delete endpoints that UI does not invoke.

---

### SB-56 — HIGH — Impersonation banner is driven by client-only UI state while privileged APIs continue to authenticate the original admin

**Verification status:** Confirmed statically; no browser/API session trace run.  
**Confidence:** High that the tested UI callback is local-only; server-side identity effects need dynamic integration validation.

**Affected files and exact source locations**

- `src/App.tsx:28–30, 104–120` — impersonated identity is React state; API-facing app receives the same existing current user/token state.
- `src/pages/AdminPage.tsx:412–419` — on impersonate, finds the user in `usersList` and calls only `setImpersonatedUser(u)`.
- `src/layout/ImpersonationBanner.tsx:10–24` — banner states “you are viewing WorkPerHour as” the selected user.
- `src/hooks/workstream/useWorkstream.ts:37` and `src/hooks/workstream/useWorkstreamList.ts:26–53` — selected user ID affects client-side WorkStream state/filtering.
- `server/routes/adminRoutes.ts:879–918` — real server endpoints exist for start/stop impersonation, but the reviewed frontend does not call `/api/admin/users/:id/impersonate` or `/stop-impersonate`; those server handlers log/notify but do not mint an impersonated identity token.

**Split-brain description**

The displayed identity and some client-side filters switch, but the authentication token used for API calls remains the original admin token. This makes the “view as user” banner misleading and can cause data/actions to be performed with the administrator’s privileges even while the interface appears to act as the target user. The backend endpoint itself also does not appear to switch server request identity; it mainly logs and notifies.

**Reproduction / falsification scenario**

As admin, choose “impersonate” for a non-admin user. Inspect Network requests and Authorization headers: check whether the server impersonation endpoint is called and whether the bearer token or server session changes. Then perform a protected action and compare the authenticated actor in server logs/audit records with the banner identity.

**Minimal safe correction**

Implement an explicit server-side impersonation session with a separate effective-user context and retained actor-admin identity, short expiry, scope restrictions, visible banner, start/stop audit entries, and guaranteed termination. Do not simply mint a normal user token or weaken role checks. If the feature is only a visual preview, remove operational wording and disable privileged actions.

**File-level issue IDs**

- `src/App.tsx` — Stores impersonatedUser only in React state.
- `src/pages/AdminPage.tsx` — Impersonation action just assigns a local user object; it does not call server impersonation endpoints.
- `src/components/admin_modules/AdminUsersModule.tsx` — Calls a prop callback to impersonate, not backend API itself.
- `src/layout/ImpersonationBanner.tsx` — Claims the super admin is viewing as the target user.
- `src/hooks/workstream/useWorkstream.ts` — Uses the local impersonated user ID in client-side WorkStream state.
- `src/hooks/workstream/useWorkstreamList.ts` — Uses local impersonated user ID for client-side filtering.
- `server/routes/adminRoutes.ts` — Server impersonate/stop endpoints audit and notify but are not called by the UI path.
- `src/utils/authToken.ts` — Current Bearer token remains the original admin session (token utility supplies API auth).

---

## v5 cross-file contradiction map

| Domain | Contradicting files/components | Consequence | Verification status |
|---|---|---|---|
| WorkStream attachments | `src/utils/workstreamUpload.ts`; three WorkStream callers; `server/routes/workstreamRoutes.ts`; `server/services/workstreamService.ts` | Upload lacks access-control scope that recipient download needs | Confirmed statically; integration reproduction pending |
| Auth request failure handling | `server/routes/index.ts`; `server/middleware/auth.ts`; `package.json` | Rejected DB lookup promise is not forwarded under Express 4 | Confirmed statically; outage path conditional |
| Session expiration | `src/server/siteSettings.ts`; `server/middleware/auth.ts`; `server/routes/authRoutes.ts`; `server/services/authService.ts` | Config says 60 minutes while issued tokens default to seven days | Confirmed statically |
| Username identity | `server/routes/userRoutes.ts`; `server/db/migration.sql`; `server/store.ts` | Application-level uniqueness precheck can race without DB unique invariant | Race-conditional |
| Admin transaction operations | `src/pages/AdminPage.tsx`; nine `src/components/admin_modules/Admin*Module.tsx` files; `server/routes/financialRoutes.ts`; `server/routes/adminRoutes.ts` | Admin screens can render empty state and confirm local-only changes | Confirmed statically; browser reproduction pending |
| Admin user management | `src/App.tsx`; `src/pages/AdminPage.tsx`; `src/components/admin_modules/AdminUsersModule.tsx`; `server/routes/adminRoutes.ts` | Empty user array/no-op setter and missing backend callbacks | Confirmed statically |
| Admin impersonation | `src/App.tsx`; `src/pages/AdminPage.tsx`; `src/layout/ImpersonationBanner.tsx`; `src/hooks/workstream/useWorkstream.ts`; `src/hooks/workstream/useWorkstreamList.ts`; `server/routes/adminRoutes.ts` | UI identity changes without corresponding server/auth identity change | Confirmed statically; request trace pending |
| Fees | `src/shared/fees.ts`; `src/server/siteSettings.ts`; `src/pages/AdminPage.tsx`; route/service implementations and tests listed in SB-01 onward | Multiple default fee representations | Confirmed static discrepancy retained from prior report |

## Current remediation order (combines old and new findings)

1. **Protect financial and user data:** resolve public-user projection issues, payout idempotency/state races, invalid webhook amount validation, wallet freeze enforcement, user deletion policy, and ledger reconciliation (see prior SB-34–SB-49 findings).
2. **Unblock and isolate order transactions:** fix the gig seller-ID naming mismatch in `server/routes/orderRoutes.ts` ↔ `server/services/orderService.ts`; enforce a separate Order + WorkStream + Escrow for each purchase/accepted project; fix upload association (SB-50).
3. **Correct the one authoritative fee policy:** reconcile `src/shared/fees.ts`, `src/server/siteSettings.ts`, `src/pages/AdminPage.tsx`, checkout, financial services, refunds, invoices, payout and tests against the required 20% commission / 5.5% client service fee / $3.50 fee only below $200.
4. **Make admin actions honest and durable:** connect the Admin tabs and user-management actions to backend APIs; implement server-side impersonation (or clearly label/disable it as visual preview). Never show a success toast before server persistence.
5. **Enforce identity/security settings:** session TTL policy, username uniqueness at database level, verification settings, and explicit async middleware error forwarding.
6. **Make the release workflow reproducible:** configure server/client builds, a test script, migrations, clean install instructions, CI results, and end-to-end regression for all release-blocking flows.

## Complete file-level issue register (271 archive paths)

This is the authoritative per-file index for the current v5 findings. A flagged file may be a directly defective file, a caller, configuration, or persistence layer that participates in a cross-file mismatch. A blank finding ID means no direct finding was assigned; it is **not** proof the file is defect-free. The CSV companion is easier to filter/sort.

| File path | Split-brain status | Finding IDs | Severity summary | Evidence summary |
|---|---|---|---|---|
| `metadata.json` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `TABLE_OF_CONTENTS.md` | ISSUE IDENTIFIED | SB-20 | MEDIUM | Inventory references files/components absent from archive |
| `README.md` | ISSUE IDENTIFIED | SB-20; SB-32 | HIGH; MEDIUM | Generic AI Studio onboarding contradicts actual backend app |
| `.env.example` | ISSUE IDENTIFIED | SB-21; SB-31 | HIGH; MEDIUM | Gateway key operations are not documented as required |
| `.gitignore` | ISSUE IDENTIFIED | SB-14 | HIGH | Does not exclude PostgreSQL runtime directory |
| `data/pgdata/base/4/2832` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3118` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3350` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3429` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3439` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2660` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2663` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2681` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2679` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2680` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2678` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2701` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2696` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2693` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2690` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2703` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2831` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2835` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2836` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2837` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2839` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3081` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3119` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3164` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3433` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3431` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2838` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `docs/API_REFERENCE.md` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `docs/COMMERCIAL_ARCHITECTURE.md` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `docs/GETTING_STARTED.md` | ISSUE IDENTIFIED | SB-13; SB-20; SB-32 | CRITICAL; HIGH; MEDIUM | Claims full-stack npm dev and npm test not implemented as documented |
| `index.html` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `docs/SENIOR_REVIEW_CHECKLIST.md` | ISSUE IDENTIFIED | SB-13; SB-20; SB-22 | CRITICAL; HIGH; MEDIUM | PASS claims reference missing/unrun tests |
| `public/robots.txt` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `package.json` | ISSUE IDENTIFIED | SB-13; SB-20; SB-22; SB-32; SB-33; SB-39; SB-51 | CRITICAL; HIGH; MEDIUM; HIGH / CONDITIONAL | No test/start scripts, Vite-only dev, build artifact mismatch \| SB-39: dotenv is loaded after static imports that capture secrets and cloud bucket configuration \| SB-51: Uses Express 4.21.2 |
| `logs123/runtime-diagnostics.txt` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `public/sitemap.xml` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `scripts/apply-patch.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `package-lock.json` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `scripts/generate_fresh_dataset.js` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `scripts/stamp-build.mjs` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/cloudStorage.ts` | ISSUE IDENTIFIED | SB-07; SB-24; SB-39 | HIGH; HIGH / CONDITIONAL | Cloud-only uploads and cleanup deletion mismatch \| SB-39: dotenv is loaded after static imports that capture secrets and cloud bucket configuration |
| `server/jobs/backgroundJobs.ts` | ISSUE IDENTIFIED | SB-07; SB-24 | HIGH | Hourly cleanup invokes retention logic without reference/cloud-object proof |
| `public/assets/aistudio/image_1373a4be.png` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/access.ts` | ISSUE IDENTIFIED | SB-07; SB-23 | HIGH | Reference helper stub and duplicate conflicting file-validation policy |
| `scripts/verify-build.mjs` | ISSUE IDENTIFIED | SB-13; SB-20; SB-33 | CRITICAL; MEDIUM | Expects server.js not emitted by declared build; build guard only tests artifact freshness |
| `server/db/migration.sql` | ISSUE IDENTIFIED | SB-04; SB-05; SB-16; SB-19; SB-40; SB-45; SB-46; SB-49; SB-53 | CRITICAL; HIGH; HIGH / CONDITIONAL; MEDIUM; MEDIUM (RACE-CONDITIONAL); MEDIUM (RETENTION-POLICY) | Missing relationships/integrity constraints and race protections \| SB-40: Caller-controlled payout ID can collide with an existing payout and the second UPSERT rewrites its identity/history \| SB-45 135–142, 364–370, 571–574: Order/escrow schemas persist fee breakdown and fee-related fields, allowing historical calculations to differ from current defaults. \| SB-46 157–173: reviews table has PRIMARY KEY(id) but no UNIQUE(order_id, reviewer_id) constraint. \| SB-49 108–173, 175–190, 253–279, 291 onward: Orders/messages/reviews/uploads/payouts/support tickets/user emails use user IDs across tables; relevant shown schemas do not declare user foreign keys that would cascade or block deletion. \| SB-53: users.username has no UNIQUE constraint or unique index on LOWER(username) |
| `server/db/postgresStore.ts` | ISSUE IDENTIFIED | SB-04; SB-05; SB-07; SB-15; SB-19; SB-31 | CRITICAL; HIGH | Persistence and reference cleanup concerns; payout and settings storage paths |
| `server/middleware/auth.ts` | ISSUE IDENTIFIED | SB-21; SB-30; SB-34; SB-39; SB-51; SB-52 | HIGH; MEDIUM; HIGH / CONDITIONAL | Shared status policy not applied to every new funded order path \| SB-34: Public user-by-ID endpoint returns an internal user object instead of a public projection \| SB-39: dotenv is loaded after static imports that capture secrets and cloud bucket configuration \| SB-51: Awaited database lookup is outside a try/catch and errors are not passed to next(err) \| SB-52: signToken default TTL is seven days |
| `server/routes/adminRoutes.ts` | ISSUE IDENTIFIED | SB-08; SB-09; SB-15; SB-31; SB-49; SB-54; SB-55; SB-56 | HIGH; MEDIUM (RETENTION-POLICY) | Admin settings persistence and policy/gateway enforcement \| SB-49 948–985: After guards, deletes only gigs, projects, and users, then reports that the account and associated gigs/projects were cleared. \| SB-54: Backend admin endpoints exist but are not called by the above modules \| SB-55: Has real admin user update/status/delete endpoints that UI does not invoke \| SB-56: Server impersonate/stop endpoints audit and notify but are not called by the UI path |
| `server/routes/authRoutes.ts` | ISSUE IDENTIFIED | SB-09; SB-36; SB-52 | HIGH | Email verification and password/registration settings mismatch \| SB-36: Signup marks the email verified before the verification code is proven \| SB-52: Signup and login call signToken without overriding token TTL |
| `server/publicData.ts` | ISSUE IDENTIFIED | SB-26; SB-34 | HIGH / LATENT; HIGH | Public gig eligibility policy stronger than order resolver gate \| SB-34: Public user-by-ID endpoint returns an internal user object instead of a public projection |
| `server/routes/gigRoutes.ts` | ISSUE IDENTIFIED | SB-26 | HIGH / LATENT | Listing/detail gates not mirrored in order route |
| `server/routes/index.ts` | ISSUE IDENTIFIED | SB-41; SB-51 | MEDIUM | No direct finding assigned in this targeted pass \| SB-41: Payout compatibility aliases contain an extra `/api` prefix and resolve to `/api/api/...` \| SB-51: Mounts the async auth middleware globally before API routes |
| `server/routes/notificationRoutes.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/routes/projectRoutes.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/routes/financialRoutes.ts` | ISSUE IDENTIFIED | SB-01; SB-02; SB-10; SB-12; SB-38; SB-41; SB-45; SB-47; SB-54 | CRITICAL; HIGH; HIGH / RELEASE BLOCKER IF LIVE PAYMENTS CLAIMED; MEDIUM; MEDIUM (WEBHOOK-CONDITIONAL) | Fee fallbacks, mock checkout/webhook binding, top-up/report drift \| SB-38: Dedicated Admin Payouts tab is a local-state demo, not connected to its financial API \| SB-41: Payout compatibility aliases contain an extra `/api` prefix and resolve to `/api/api/...` \| SB-45 331–338: earnedToDate uses user.earned when nonzero, otherwise recalculates all completed orders using DEFAULT_FEE_CONFIG; earnedThisMonth recalculates current month using current defaults. \| SB-45 355–358: Returns earnedToDate, earnedThisMonth, and earnedPastTwoMonths: earnedThisMonth, so the two-month value exactly duplicates the current-month value. \| SB-47 457–500: Verifies HMAC, then gates on event/userId/amount truthiness and calls creditDeposit with Number(amount); it does not enforce finite positive amount or currency/payment-intent binding here. \| SB-54: Backend financial endpoints exist but are not called by the above modules |
| `server/routes/orderRoutes.ts` | ISSUE IDENTIFIED | SB-01; SB-02; SB-03; SB-05; SB-06; SB-25; SB-26; SB-27; SB-28; SB-30; SB-42 | CRITICAL; HIGH; HIGH / LATENT; MEDIUM | Financial/path mismatch, project validation, rollback, workspace reuse, purchase bug/gates/deadline/policy \| SB-42: Workspace invariant test explicitly permits multiple independent orders to share one WorkStream |
| `server/routes/proposalRoutes.ts` | ISSUE IDENTIFIED | SB-02; SB-03; SB-05; SB-16; SB-28; SB-44 | CRITICAL; HIGH; HIGH / CONDITIONAL; MEDIUM | Legacy fee values, project binding/funding rollback/race, escrow duration \| SB-44 106–138: Reads bidAmount and deliveryDays and inserts only cover letter, bid amount, delivery days, and status; no deposit field. |
| `server/routes/rootRoutes.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/routes/reviewRoutes.ts` | ISSUE IDENTIFIED | SB-46 | MEDIUM (RACE-CONDITIONAL) | SB-46 112–137: Checks for an existing review by order_id + reviewer_id, then builds/inserts a review in a later operation. |
| `server/routes/userRoutes.ts` | ISSUE IDENTIFIED | SB-34; SB-35; SB-37; SB-53 | HIGH; MEDIUM | No direct finding assigned in this targeted pass \| SB-34: Public user-by-ID endpoint returns an internal user object instead of a public projection \| SB-35: Notification-preferences GET route is shadowed by the earlier dynamic user-ID route \| SB-37: Authenticated email-change endpoint updates the login/recovery address without re-verifying ownership \| SB-53: Checks lowercase username uniqueness and then saves user in a separate operation |
| `server/services/authService.ts` | ISSUE IDENTIFIED | SB-09; SB-39; SB-52 | HIGH; HIGH / CONDITIONAL | Security/verification policy wiring needs consistency \| SB-39: dotenv is loaded after static imports that capture secrets and cloud bucket configuration \| SB-52: Auth service also calls signToken without overriding token TTL |
| `server/services/diagnosticService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/services/disputeService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/routes/workstreamRoutes.ts` | ISSUE IDENTIFIED | SB-02; SB-05; SB-06; SB-07; SB-12; SB-18; SB-23; SB-24; SB-28; SB-30; SB-50 | CRITICAL; HIGH; MEDIUM | Financial, workspace, upload/cleanup/validator and restriction consistency \| SB-50: Server accepts missing scope IDs and persists undefined orderId/workspaceId; download requires access check |
| `server/services/messagingService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/services/financialService.ts` | ISSUE IDENTIFIED | SB-02; SB-03; SB-04; SB-05; SB-08; SB-11; SB-12; SB-15; SB-40; SB-43; SB-47; SB-48 | CRITICAL; HIGH; MEDIUM / CONDITIONAL; HIGH / CONDITIONAL; CRITICAL / RACE-CONDITIONAL; MEDIUM (WEBHOOK-CONDITIONAL) | Source-of-truth, payout idempotency, rollback, settings and top-up consistency \| SB-40: Caller-controlled payout ID can collide with an existing payout and the second UPSERT rewrites its identity/history \| SB-43: Concurrent payout approval can revert a completed payout to approved, enabling a second settlement \| SB-47 911–948: creditDeposit adds params.amount directly to the wallet and writes ledger entries without asserting a positive, finite amount. \| SB-48 1010–1029: requestPayout locks wallet and checks only existence and available balance before subtracting the amount; it does not reject status=frozen. \| SB-48 1311–1320: freezeWallet explicitly persists wallets.status = frozen. |
| `server/services/notificationService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/services/payoutService.ts` | ISSUE IDENTIFIED | SB-04; SB-08; SB-40; SB-43; SB-48 | CRITICAL; HIGH; HIGH / CONDITIONAL; CRITICAL / RACE-CONDITIONAL | Payout replay duplication and policy limit enforcement \| SB-40: Caller-controlled payout ID can collide with an existing payout and the second UPSERT rewrites its identity/history \| SB-43: Concurrent payout approval can revert a completed payout to approved, enabling a second settlement \| SB-48 52–97: handlePayoutRequest delegates to requestPayout after auth and amount/method checks but does not reject a frozen wallet. |
| `server/services/reviewService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/websocket.ts` | ISSUE IDENTIFIED | SB-17; SB-21 | MEDIUM | Query-token logging and deployment hardening |
| `server/services/workstreamService.ts` | ISSUE IDENTIFIED | SB-07; SB-18; SB-23; SB-24; SB-50 | HIGH; MEDIUM | Unreferenced cleanup, unused extension allowlist, validator drift, local/cloud mismatch \| SB-50: File access relies on owner or participant match through stored orderId/workspaceId |
| `server/services/orderService.ts` | ISSUE IDENTIFIED | SB-03; SB-16; SB-25; SB-26 | CRITICAL; HIGH; HIGH / CONDITIONAL; HIGH / LATENT | Gig resolver field shape and route lock/project linkage issues |
| `server/ssr.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `server/store.ts` | ISSUE IDENTIFIED | SB-46; SB-49; SB-53 | MEDIUM (RACE-CONDITIONAL); MEDIUM (RETENTION-POLICY); MEDIUM | SB-46 328–357: addReview upserts only on primary key id; generated review IDs differ for concurrent requests. \| SB-49 user/order/message/review persistence paths: Store retains separate durable records beyond the users row; deletion handler does not invoke a broad per-user anonymization/deletion service. \| SB-53: saveUser performs the persistence write after the route-level precheck |
| `server.ts` | ISSUE IDENTIFIED | SB-13; SB-21; SB-32; SB-39; SB-41 | CRITICAL; HIGH; MEDIUM; HIGH / CONDITIONAL | Backend entrypoint/build/dev workflow/security headers \| SB-39: dotenv is loaded after static imports that capture secrets and cloud bucket configuration \| SB-41: Payout compatibility aliases contain an extra `/api` prefix and resolve to `/api/api/...` |
| `src/components/AdminOrdersManager.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/HeaderCategoriesNav.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/SettingsPage.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/FreelancerProfileView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/App.tsx` | ISSUE IDENTIFIED | SB-55; SB-56 | HIGH | SB-55: Passes usersList as an empty array and setUsersList as a no-op function into AdminPage \| SB-56: Stores impersonatedUser only in React state |
| `src/components/PaymentsModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_dashboard/AdminHeader.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/SiteFeeSettingsModule.tsx` | ISSUE IDENTIFIED | SB-01; SB-02; SB-29 | CRITICAL; MEDIUM | Admin simulator implements fee math separately |
| `src/components/UserWalletsLedgerModule.tsx` | ISSUE IDENTIFIED | SB-38 | HIGH | No direct finding assigned in this targeted pass \| SB-38: Dedicated Admin Payouts tab is a local-state demo, not connected to its financial API |
| `src/components/admin_dashboard/AdminSidebarNav.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_dashboard/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_dashboard/AdminOverviewMetrics.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminCategoriesModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminActivityModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `public/assets/aistudio/image_7785046a.png` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminCmsModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminDisputesModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty default data and optional resolution callback omitted |
| `src/components/admin_modules/AdminContractsModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Initial contracts default to empty and lifecycle actions only mutate component state |
| `src/components/admin_modules/AdminEscrowModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Shows release/refund success after local changes; callback props are omitted by parent |
| `src/components/admin_modules/AdminMembershipsQuotasModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminGigsModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminMessagesModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty initial threads and optional moderation callback omitted |
| `src/components/admin_modules/AdminPaymentGatewaysModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminOverviewModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminPayoutsModule.tsx` | ISSUE IDENTIFIED | SB-38; SB-54 | HIGH | No direct finding assigned in this targeted pass \| SB-38: Dedicated Admin Payouts tab is a local-state demo, not connected to its financial API \| SB-54: Empty default data; approve/process/reject modifies local state and shows success toast |
| `src/components/admin_modules/AdminRefundsModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty default data and optional refund callbacks omitted |
| `src/components/admin_modules/AdminProjectsModule.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminReportsModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty initial reports and optional report-action callbacks omitted |
| `src/components/admin_modules/AdminProposalsModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Defaults to empty array; changes only local state unless optional callbacks are supplied |
| `src/components/admin_modules/AdminReviewsModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty initial data; moderation and deletion local-only when callbacks absent |
| `src/components/admin_modules/AdminUsersModule.tsx` | ISSUE IDENTIFIED | SB-55; SB-56 | HIGH | SB-55: Edits/deletes/toggles local state; update/delete API callbacks are optional and not supplied \| SB-56: Calls a prop callback to impersonate, not backend API itself |
| `src/components/gig_reviews/Reviews.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gig_reviews/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/admin_modules/AdminSupportModule.tsx` | ISSUE IDENTIFIED | SB-54 | HIGH | SB-54: Empty initial tickets and optional reply/status callbacks omitted |
| `src/components/admin_modules/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/CreateGigView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/EditGigModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/GigDetailView.tsx` | ISSUE IDENTIFIED | SB-01; SB-02; SB-25 | CRITICAL | Fee quote/fallback and core gig purchase path impacted |
| `src/components/gigs/DeleteGigModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/RelatedGigsSection.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/ViewingGigModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/marketplace/BuyerActivityView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/gigs/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/marketplace/FreelancerSearchView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/marketplace/MarketplaceGigsView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/marketplace/ProjectSearchView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/marketplace/ProjectDetailView.tsx` | ISSUE IDENTIFIED | SB-02; SB-44 | CRITICAL; MEDIUM | Proposal UI relies on default fee engine, must reconcile to transaction snapshot \| SB-44 67, 195–200, 1054–1069: Keeps proposalDeposit state, calculates depositAmount that is not used, and shows 0%, 20%, 50%, and 100% Required Deposit options. \| SB-44 212–219: Submits projectId, bid, delivery days, and cover letter only; no deposit is sent. |
| `src/components/marketplace/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/EmailNotificationsModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/ForgotPasswordModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/LoginModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/SignupModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/SupportModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/UserSwitchModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/VerifyModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/modals/WishlistModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/profile/EditUserProfileModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/profile/EditProfilePage.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/profile/FreelancerProfileView.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/profile/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/profile/InspectUserModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/ui/MetricCard.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/ui/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/user_dashboard/UserFreelanceProjectsList.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/ui/BaseModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/user_dashboard/UserActivitySummarySidebar.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/user_dashboard/UserFreelanceOffersList.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/StartWorkstreamModal.tsx` | ISSUE IDENTIFIED | SB-27 | MEDIUM | Deadline selection not honored by backend |
| `src/components/workstream/WorkstreamActionsPanel.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamActivityStream.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/user_dashboard/UserStatsOverview.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamMessageInput.tsx` | ISSUE IDENTIFIED | SB-50 | HIGH | SB-50: Message and invoice attachment uploads call helper with only the file |
| `src/components/workstream/WorkstreamList.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/user_dashboard/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamReleaseModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamDeliverModal.tsx` | ISSUE IDENTIFIED | SB-50 | HIGH | SB-50: Delivery upload calls helper with only the file |
| `src/components/workstream/WorkstreamReviewModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamHeader.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamEmptyState.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamFilesTab.tsx` | ISSUE IDENTIFIED | SB-50 | HIGH | SB-50: Calls upload helper with only the file |
| `src/components/workstream/WorkstreamRevisionModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamSidebar.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamSummaryCard.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamVideoCallModal.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamWorkspace.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/WorkstreamTabs.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/types.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/workstream/activityClassifier.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/constants.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/entry-client.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/entry-server.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/admin/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/admin/useLocalStorageFilter.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/admin/usePagination.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/useAppData.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamActions.ts` | ISSUE IDENTIFIED | SB-27 | MEDIUM | UI calculates but fails to send selected turnaround days |
| `src/hooks/workstream/useWorkstream.ts` | ISSUE IDENTIFIED | SB-56 | HIGH | SB-56: Uses the local impersonated user ID in client-side WorkStream state |
| `src/hooks/workstream/useWorkstreamDelivery.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamFiles.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamEscrow.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamFilters.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamList.ts` | ISSUE IDENTIFIED | SB-56 | HIGH | SB-56: Uses local impersonated user ID for client-side filtering |
| `src/hooks/workstream/useWorkstreamMeeting.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamOffers.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamMessages.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamRealtime.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamReview.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamRevision.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/index.css` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/hooks/workstream/useWorkstreamSelection.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/layout/Footer.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/layout/HeaderCategoriesNav.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/layout/ImpersonationBanner.tsx` | ISSUE IDENTIFIED | SB-56 | HIGH | SB-56: Claims the super admin is viewing as the target user |
| `src/layout/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/main.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/layout/Header.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/pages/AdminPage.tsx` | ISSUE IDENTIFIED | SB-38; SB-54; SB-55; SB-56; SB-01 | HIGH; CRITICAL | No direct finding assigned in this targeted pass \| SB-38: Dedicated Admin Payouts tab is a local-state demo, not connected to its financial API \| SB-54: Renders proposal/contract/dispute/refund/payout/review/message/report/support tabs without required data or action callbacks \| SB-55: Renders AdminUsersModule with usersList and passes a local-state status toggle only \| SB-56: Impersonation action just assigns a local user object; it does not call server impersonation endpoints \| SB-01: Default props still encode 1% buyer fee and $1 small-order fee (lines 69–73), reinforcing the existing fee-policy split-brain. |
| `src/pages/SettingsPage.tsx` | ISSUE IDENTIFIED | SB-35 | MEDIUM | No direct finding assigned in this targeted pass \| SB-35: Notification-preferences GET route is shadowed by the earlier dynamic user-ID route |
| `src/pages/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/controllers/README.md` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/middleware/README.md` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/financeService.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/financeLedger.ts` | ISSUE IDENTIFIED | SB-02; SB-08; SB-12; SB-48 | CRITICAL; HIGH | Legacy finance engine diverges from production PostgreSQL paths \| SB-48 904–914, 934–940: The legacy finance ledger has a frozen-wallet restriction, creating inconsistent enforcement across the new DB transaction and legacy engine. |
| `src/server/middleware/auth.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/routes/README.md` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/server/paymentGateways.ts` | ISSUE IDENTIFIED | SB-10; SB-15; SB-31 | HIGH; HIGH / RELEASE BLOCKER IF LIVE PAYMENTS CLAIMED | No live handshake, asynchronous persistence, plaintext error fallback |
| `src/server/workspaceService.ts` | ISSUE IDENTIFIED | SB-05; SB-06; SB-42 | CRITICAL; HIGH | Workspace association/reuse and cleanup \| SB-42: Workspace invariant test explicitly permits multiple independent orders to share one WorkStream |
| `src/shared/fees.ts` | ISSUE IDENTIFIED | SB-01; SB-02; SB-11; SB-12; SB-29; SB-45 | CRITICAL; HIGH; MEDIUM; MEDIUM / CONDITIONAL | Fee defaults/condition, multi-source math, zero fallback/top-up rules, simulator drift \| SB-45 16–19: Defaults currently set the platform commission to 20%, buyer fee to 1%, and small-order fee to $1, not the agreed 5.5%/$3.50 policy. |
| `src/server/siteSettings.ts` | ISSUE IDENTIFIED | SB-01; SB-02; SB-08; SB-09; SB-15; SB-28; SB-29; SB-36; SB-37; SB-52 | CRITICAL; HIGH; MEDIUM | Defaults/comments, setting wiring/persistence, payout and security settings, duration drift \| SB-36: Signup marks the email verified before the verification code is proven \| SB-37: Authenticated email-change endpoint updates the login/recovery address without re-verifying ownership \| SB-52: Declares sessionTimeoutMinutes=60 and other security options |
| `src/shared/routes.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/types.ts` | ISSUE IDENTIFIED | SB-34; SB-44 | HIGH; MEDIUM | SB-44 135–149: Proposal interface contains no deposit property. |
| `src/utils/api.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/authToken.ts` | ISSUE IDENTIFIED | SB-56 | HIGH | SB-56: Current Bearer token remains the original admin session (token utility supplies API auth) |
| `src/utils/fetchRetry.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/deviceId.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/index.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/formatters.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/messageTime.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/slugify.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/utils/safeFileLink.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `test-pglite.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/concurrency-race-stress.test.ts` | ISSUE IDENTIFIED | SB-16; SB-22 | HIGH; HIGH / CONDITIONAL | Race suite exists but was not run/verified |
| `src/utils/workstreamUpload.ts` | ISSUE IDENTIFIED | SB-50 | HIGH | SB-50: Upload URL sends only name; orderId/workspaceId are omitted |
| `tests/fees.test.ts` | ISSUE IDENTIFIED | SB-01; SB-13 | CRITICAL | Test assertions validate wrong fee policy despite title |
| `tests/gig-cancellation-clearance.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/ledger.safety.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/activity-stream-cards.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/fee-wiring.test.ts` | ISSUE IDENTIFIED | SB-13; SB-25; SB-33 | CRITICAL; MEDIUM | Route scan can false-pass and does not require server bundle |
| `tests/auto-accept.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/phase3-workspace-invariants.test.ts` | ISSUE IDENTIFIED | SB-06; SB-42 | HIGH | Workspace reuse invariant conflicts with per-transaction isolation requirement \| SB-42: Workspace invariant test explicitly permits multiple independent orders to share one WorkStream |
| `tests/postgres-persistence.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/ledger.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/recovery-test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/proposal-link-test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/safe-file-link.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/security-fixes-test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/signup-role.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/security.test.ts` | ISSUE IDENTIFIED | SB-13 | CRITICAL | Imports compiled server.js absent in archive and not generated by declared build |
| `tests/ssr.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/webhook.test.ts` | ISSUE IDENTIFIED | SB-10; SB-22 | HIGH; HIGH / RELEASE BLOCKER IF LIVE PAYMENTS CLAIMED | Webhook test existence is not proof of real checkout/provider binding; not run |
| `tests/workspace-validation.test.ts` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `tests/workstream.test.ts` | ISSUE IDENTIFIED | SB-07; SB-18; SB-22; SB-24 | HIGH; MEDIUM | WorkStream retention/upload tests not run; cloud/local contract missing |
| `tsconfig.json` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/ui/Avatar.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `src/components/ui/GigImage.tsx` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `data/pgdata/PG_VERSION` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/112` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/113` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1247` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `bun.lock` | No direct finding assigned | — | — | No direct finding assigned in this targeted pass |
| `data/pgdata/base/1/1247_fsm` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1247_vm` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249_vm` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249_fsm` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/global/pg_internal.init` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_multixact/offsets/0000` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_subtrans/0000` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_logical/replorigin_checkpoint` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/5/pg_internal.init` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/global/pg_control` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_xact/0000` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/postmaster.pid` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_wal/000000010000000000000001` | ISSUE IDENTIFIED | SB-14 | HIGH | Runtime PostgreSQL data file packaged in source ZIP |
| `vite.config.ts` | ISSUE IDENTIFIED | SB-32 | HIGH | No API/WebSocket proxy and no Express runner |

## Historical reports consolidated below

The complete v4 master report is preserved verbatim below. v4 already carried v1–v3 findings and the initial F-01–F-11 audit forward. The separate v5 CSV and inventory have been updated with SB-50 through SB-56 and the additional file-to-finding relationships.

---

# FivePa Master Advanced Split-Brain Audit — Version 4 (Combined and Extended)

**Target:** `fivepa-freelance-marketplace (4)(1).zip`  
**Archive SHA-256:** `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`  
**Audit date:** 24 October 2026  
**Archive file entries:** 271 (directory entries excluded)  
**Numbered findings:** 49 (SB-01 through SB-49; six new findings appended to v3)  
**File paths assigned at least one issue/finding:** 101 of 271. This is an evidence-mapping count, not a count of defective files.

## Executive verdict

**Release recommendation: HOLD.** The combined static audit identifies policy/code/test disagreements in money handling, order/workspace isolation, user-data exposure, payout state handling, account verification, and release/test reproducibility. This v4 adds six new findings after SB-43. Earlier findings and earlier reports are preserved verbatim in the historical section below, so the combined document carries the prior evidence and provenance forward.

## Provenance and verification boundaries

The freshly uploaded ZIP at the target path has SHA-256 `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`, matching the earlier archive byte-for-byte. This pass inspected the extracted source in `/tmp/fivepa_audit` and compared it with the previous v3 report/matrix. The source snapshot has not been changed by this audit. No production service was accessed. Static issues are identified as such; race and adversarial webhook scenarios have not been dynamically reproduced.

Earlier package-command observations remain in force: `npm test` is unavailable because `package.json` has no test script; `npm run build` reported `vite: not found` and `npm run lint` reported missing `vite/client` types in the dependency-absent extracted environment. Those two results do not prove they fail after a clean successful dependency install. `npm ci` timed out in the previous execution environment. The current report does not claim the complete automated suite passed.

## New findings SB-44 through SB-49

### SB-44 — MEDIUM — Proposal UI advertises a deposit rule that the backend does not store or enforce

**Verification status:** Confirmed statically; user-facing runtime not reproduced  
**Confidence:** High for source mismatch

**Affected files and exact source locations**

- `src/components/marketplace/ProjectDetailView.tsx:67, 195–200, 1054–1069` — Keeps proposalDeposit state, calculates depositAmount that is not used, and shows 0%, 20%, 50%, and 100% Required Deposit options.
- `src/components/marketplace/ProjectDetailView.tsx:212–219` — Submits projectId, bid, delivery days, and cover letter only; no deposit is sent.
- `server/routes/proposalRoutes.ts:106–138` — Reads bidAmount and deliveryDays and inserts only cover letter, bid amount, delivery days, and status; no deposit field.
- `src/types.ts:135–149` — Proposal interface contains no deposit property.

**Split-brain description**

The project proposal UI presents deposit percentages and an “Escrow deposit before work begins” label, but the selected deposit is dead state: depositAmount is calculated and never used, and the API contract/database insert do not include it. This conflicts with the project rule that proposals contain price, delivery time, and description only, and the accepted order is funded in full.

**Potential impact**

Users may believe they can select or negotiate a deposit percentage when it has no effect. It contradicts the platform contract and creates misleading pricing/workflow UI.

**Reproduction scenario**

Open a project detail, change Required Deposit from 20% to 100%, submit a proposal, and inspect the POST body and proposals row. The deposit choice is absent; acceptance uses the bid amount rather than the chosen percentage.

**Minimal safe correction**

Remove the deposit state, calculation, UI, text, and any associated stale copy. Keep the proposal DTO limited to price, delivery days, and cover letter/description; add a test that no deposit field is present and acceptance fully funds the accepted price.

### SB-45 — MEDIUM — Financial snapshot mixes stored lifetime earnings with current-policy recomputation and duplicates the two-month figure

**Verification status:** Confirmed statically; totals not compared against a live database  
**Confidence:** High

**Affected files and exact source locations**

- `server/routes/financialRoutes.ts:331–338` — earnedToDate uses user.earned when nonzero, otherwise recalculates all completed orders using DEFAULT_FEE_CONFIG; earnedThisMonth recalculates current month using current defaults.
- `server/routes/financialRoutes.ts:355–358` — Returns earnedToDate, earnedThisMonth, and earnedPastTwoMonths: earnedThisMonth, so the two-month value exactly duplicates the current-month value.
- `server/db/migration.sql:135–142, 364–370, 571–574` — Order/escrow schemas persist fee breakdown and fee-related fields, allowing historical calculations to differ from current defaults.
- `src/shared/fees.ts:16–19` — Defaults currently set the platform commission to 20%, buyer fee to 1%, and small-order fee to $1, not the agreed 5.5%/$3.50 policy.

**Split-brain description**

The snapshot has three incompatible earnings truths: user.earned (a possibly stale aggregate), current-default recomputation for monthly earnings, and a past-two-month field copied directly from current-month earnings. Recomputing old orders from current defaults can diverge from each order’s stored fee breakdown.

**Potential impact**

Freelancers and admins can see inconsistent reported income; payout reconciliations and finance dashboards can disagree with order-level fees and the ledger.

**Reproduction scenario**

Use a completed order whose stored fee_breakdown differs from DEFAULT_FEE_CONFIG and a user with a non-zero earned aggregate. Compare the endpoint values with sums of stored feeBreakdown/ledger entries; also compare earnedPastTwoMonths to an actual rolling two-month query.

**Minimal safe correction**

Use the stored historical fee breakdown or ledger as the source of truth for earned values. Define the exact time windows for current month and previous/two months, query them independently, and add reconciliation assertions against ledger movements.

### SB-46 — MEDIUM (RACE-CONDITIONAL) — Review duplicate prevention is check-then-insert without a database uniqueness invariant

**Verification status:** Confirmed statically; concurrent duplicate not dynamically reproduced  
**Confidence:** High for race window

**Affected files and exact source locations**

- `server/routes/reviewRoutes.ts:112–137` — Checks for an existing review by order_id + reviewer_id, then builds/inserts a review in a later operation.
- `server/store.ts:328–357` — addReview upserts only on primary key id; generated review IDs differ for concurrent requests.
- `server/db/migration.sql:157–173` — reviews table has PRIMARY KEY(id) but no UNIQUE(order_id, reviewer_id) constraint.

**Split-brain description**

Two simultaneous review submissions can both pass the pre-check and insert distinct UUIDs. The application-level duplicate check is not protected by a transaction/lock or a database unique constraint.

**Potential impact**

Duplicate reviews and inflated ratings/counts can be persisted during a race. This is conditional on concurrent submissions, not proven to occur in a live deployment.

**Reproduction scenario**

Submit two POST review requests for the same order and reviewer in parallel. Inspect reviews rows for duplicate (order_id, reviewer_id).

**Minimal safe correction**

Add a partial unique index on (order_id, reviewer_id) where both values are non-null if the model permits nulls, handle unique-violation responses as 409, and make the operation transactional. Keep PUT editing as the only path to modify an existing review.

### SB-47 — MEDIUM (WEBHOOK-CONDITIONAL) — Signed payment webhook accepts a truthy negative amount and deposit service lacks amount validation

**Verification status:** Confirmed statically; requires a valid signer/provider payload to trigger  
**Confidence:** High for missing validation; low likelihood absent signer compromise/provider defect

**Affected files and exact source locations**

- `server/routes/financialRoutes.ts:457–500` — Verifies HMAC, then gates on event/userId/amount truthiness and calls creditDeposit with Number(amount); it does not enforce finite positive amount or currency/payment-intent binding here.
- `server/services/financialService.ts:911–948` — creditDeposit adds params.amount directly to the wallet and writes ledger entries without asserting a positive, finite amount.

**Split-brain description**

A validly signed payment.succeeded payload whose amount is negative, non-finite/coercion-invalid, or not linked to a real checkout intent is not rejected explicitly by these layers. The signature check is a positive control, but it does not validate business semantics.

**Potential impact**

If a trusted signer/provider emits or an operational signing key is misused to sign malformed data, a “deposit” can subtract wallet funds or record invalid ledger amounts. The normal external provider is not assumed to do this; the finding is a defensive control gap.

**Reproduction scenario**

In a test environment with a known webhook secret, sign a payment.succeeded body with amount:-100 and a provider reference, then inspect response, wallet balance, and ledger entries. Also test NaN-like strings, zero, currency mismatch, and unknown checkout references.

**Minimal safe correction**

Validate amount as a finite positive decimal at both route and service boundaries, validate expected currency, and require a persisted checkout/payment-intent record with matching user, amount, currency, and provider transaction ID before crediting.

### SB-48 — HIGH — Frozen wallet status is set in one financial path but ignored by the payout request transaction

**Verification status:** Confirmed statically; runtime payout not executed  
**Confidence:** High

**Affected files and exact source locations**

- `server/services/financialService.ts:1010–1029` — requestPayout locks wallet and checks only existence and available balance before subtracting the amount; it does not reject status=frozen.
- `server/services/financialService.ts:1311–1320` — freezeWallet explicitly persists wallets.status = frozen.
- `server/services/payoutService.ts:52–97` — handlePayoutRequest delegates to requestPayout after auth and amount/method checks but does not reject a frozen wallet.
- `src/server/financeLedger.ts:904–914, 934–940` — The legacy finance ledger has a frozen-wallet restriction, creating inconsistent enforcement across the new DB transaction and legacy engine.

**Split-brain description**

The database-backed payout request path is not aligned with the wallet freeze state. A wallet frozen by the financial service can still pass the requestPayout checks if it has enough available balance.

**Potential impact**

An account that has been frozen for security, dispute, or administrative reasons may still create a pending withdrawal. Even if settlement later fails, allowing the request itself violates the freeze invariant and complicates ops/compliance.

**Reproduction scenario**

Freeze a test user’s wallet, then POST a valid payout request for an amount within available balance. Check whether a pending payout is created and wallet balance/pending withdrawals change.

**Minimal safe correction**

Inside the same transaction that locks the wallet, require wallet.status === active before changing balances or inserting a payout. Repeat the guard in any direct/legacy payout entry point, and add tests proving frozen wallets cannot request or settle withdrawals.

### SB-49 — MEDIUM (RETENTION-POLICY) — Admin hard delete removes the user row but leaves related transaction and personal-data records without a documented tombstone/anonymization contract

**Verification status:** Confirmed statically; effects depend on existing database contents and FK/index setup  
**Confidence:** High for incomplete deletion sequence

**Affected files and exact source locations**

- `server/routes/adminRoutes.ts:948–985` — After guards, deletes only gigs, projects, and users, then reports that the account and associated gigs/projects were cleared.
- `server/db/migration.sql:108–173, 175–190, 253–279, 291 onward` — Orders/messages/reviews/uploads/payouts/support tickets/user emails use user IDs across tables; relevant shown schemas do not declare user foreign keys that would cascade or block deletion.
- `server/store.ts:user/order/message/review persistence paths` — Store retains separate durable records beyond the users row; deletion handler does not invoke a broad per-user anonymization/deletion service.

**Split-brain description**

The deletion endpoint hard-deletes the user row and their gigs/projects but leaves other rows referencing that user ID, potentially including wallet/ledger/payout history, completed orders, messages/reviews, email history, uploads, proposals, WorkStreams, support tickets, and audit trails. The audit message claims more than the route visibly does.

**Potential impact**

Orphaned records, stale UI references, data-retention inconsistencies, and potential persistence of personal data after a user deletion request. Financial/legal retention obligations may mean some records should be retained, so blindly cascading all records is not the safe fix.

**Reproduction scenario**

In a disposable seeded database, create a user with a completed order, messages, review, upload, payout history, and email history; invoke the admin delete endpoint; query each related table afterward and check references/display behavior.

**Minimal safe correction**

Define a documented deletion policy: soft-delete and anonymize personal/profile fields while preserving financial ledger/order records required for audit, delete unreferenced uploads, redact or pseudonymize messages where lawful, and ensure all retained references point to a tombstone. Make the operation transactional and make the audit log accurately describe what was actually removed.

## Cross-file quick matrix — new v4 findings

| Finding | Files implicated | Status |
|---|---|---|
| SB-44 (MEDIUM) | `src/components/marketplace/ProjectDetailView.tsx`, `src/components/marketplace/ProjectDetailView.tsx`, `server/routes/proposalRoutes.ts`, `src/types.ts` | Confirmed statically; user-facing runtime not reproduced |
| SB-45 (MEDIUM) | `server/routes/financialRoutes.ts`, `server/routes/financialRoutes.ts`, `server/db/migration.sql`, `src/shared/fees.ts` | Confirmed statically; totals not compared against a live database |
| SB-46 (MEDIUM (RACE-CONDITIONAL)) | `server/routes/reviewRoutes.ts`, `server/store.ts`, `server/db/migration.sql` | Confirmed statically; concurrent duplicate not dynamically reproduced |
| SB-47 (MEDIUM (WEBHOOK-CONDITIONAL)) | `server/routes/financialRoutes.ts`, `server/services/financialService.ts` | Confirmed statically; requires a valid signer/provider payload to trigger |
| SB-48 (HIGH) | `server/services/financialService.ts`, `server/services/financialService.ts`, `server/services/payoutService.ts`, `src/server/financeLedger.ts` | Confirmed statically; runtime payout not executed |
| SB-49 (MEDIUM (RETENTION-POLICY)) | `server/routes/adminRoutes.ts`, `server/db/migration.sql`, `server/store.ts` | Confirmed statically; effects depend on existing database contents and FK/index setup |

## Consolidated priority order

1. **Critical financial and access-control defects from earlier findings:** public user projection, payout idempotency/state race, fee calculation mismatch, and the gig-order seller ID naming blocker.
2. **High payout/wallet invariants:** enforce frozen-wallet blocks inside the locked database transaction; make payout approval/settlement state changes conditional and atomic.
3. **Payment/webhook integrity:** reject invalid amounts, verify currency and provider intent, and use immutable provider IDs/idempotency records.
4. **Every new purchase gets its own Order + WorkStream + Escrow:** do not reuse workspace by buyer/seller identity and keep final submission tied to the existing order.
5. **Remove misleading proposal-deposit UI and reconcile earnings views against historical order fee breakdowns/ledger.**
6. **Database integrity and user lifecycle:** enforce review uniqueness in the database and implement deliberate delete/anonymize/tombstone policy.
7. **Clean install/build/test:** run real CI and browser/database/provider integration suites, recording exact commit/archive hash and outputs.

## Fresh-pass file listing by issue

The full 271-path matrix is provided in `FivePa_File_Level_Split_Brain_Matrix_v4.csv`, and the human-readable complete inventory is `FivePa_Master_File_Inventory_v4.md`. Files implicated by new findings include:

- **SB-44** — `src/components/marketplace/ProjectDetailView.tsx`, `src/components/marketplace/ProjectDetailView.tsx`, `server/routes/proposalRoutes.ts`, `src/types.ts`
- **SB-45** — `server/routes/financialRoutes.ts`, `server/routes/financialRoutes.ts`, `server/db/migration.sql`, `src/shared/fees.ts`
- **SB-46** — `server/routes/reviewRoutes.ts`, `server/store.ts`, `server/db/migration.sql`
- **SB-47** — `server/routes/financialRoutes.ts`, `server/services/financialService.ts`
- **SB-48** — `server/services/financialService.ts`, `server/services/financialService.ts`, `server/services/payoutService.ts`, `src/server/financeLedger.ts`
- **SB-49** — `server/routes/adminRoutes.ts`, `server/db/migration.sql`, `server/store.ts`

**Interpretation warning:** “file implicated” includes both sides of a cross-file disagreement and files supporting evidence; not every listed file is itself faulty. `No direct finding assigned` is not a clean bill of health.

---

## Full previous consolidated report, preserved verbatim for history and combined-report completeness

# FivePa Master Advanced Split-Brain Audit — Version 3 (Consolidated)

**Target:** `fivepa-freelance-marketplace (4)(1).zip`  
**Archive SHA-256:** `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`  
**Audit date:** 24 October 2026  
**File inventory:** 271 files, excluding directory entries  
**Unique numbered findings:** 43 (SB-01 through SB-43; SB-01 through SB-33 from the previous master report plus ten additional findings in this pass)  
**Files with at least one issue assignment:** 99 of 271 archive files. This is an evidence-mapping count, not a count of defective files; some entries are evidence files for cross-file findings.

## Updated executive verdict

**Release recommendation: HOLD pending fixes to critical financial and access-control issues and evidence-based regression tests.** This v3 report combines the original baseline findings (F-01 through F-11), the prior combined audit, and all findings SB-01 through SB-33, then adds ten more source-level findings (SB-34 through SB-43). The full v2 report is preserved verbatim below for traceability; the updated file-level CSV and inventory include the new IDs.

New high-priority additions include: (1) an unauthenticated user-by-ID endpoint returning the broad `safeUser` projection rather than the public allow-list, (2) signup setting `emailVerified: true` before code proof, (3) unverified email changes, (4) payout admin UI actions that only mutate local React state, and (5) a payout approval/settlement race in which a stale approval can revert a settled payout to `approved` and enable a second settlement attempt. These are source-level findings; no live production system was accessed.

## Provenance and verification boundaries

The latest upload and the prior ZIP are byte-identical with SHA-256 `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`. This means the expanded findings represent additional inspection of the same source snapshot, not a code difference in the archive. The archive has 271 files excluding directory entries, and the same full inventory is provided separately.

Checks performed include direct source inspection, route/middleware composition analysis, cross-file symbol and setting searches, comparison with the earlier reports, and inspection of payout/order/workspace logic. The earlier run also observed `npm test` fail because `package.json` has no `test` script. In the extracted environment, `npm run build` reported `vite: not found` and `npm run lint` reported missing `vite/client` types because dependencies were not installed in that environment; those two outcomes are **not** evidence that either command fails after a successful dependency install. No full browser, database, email provider, cloud storage, payment provider, or concurrency test was executed in this pass. Race findings are marked statically confirmed but not dynamically reproduced.

Verification labels used here: **Confirmed statically** = source/control-flow contradiction is directly visible; **Conditional** = exploitability depends on data/config/deployment assumptions; **Not dynamically reproduced** = an appropriate runtime test was not executed. No application source code was modified as part of this audit.

## New findings in this pass — SB-34 to SB-43

"Split-brain" is used here to mean two layers, two routes, a route and its consumer, code and tests, or transaction state and side effects disagree about the same contract. Findings may cite multiple files; the file-level matrix identifies every path implicated by each finding.

## SB-34 — HIGH — Public user-by-ID endpoint returns an internal user object instead of a public projection

**Verification status:** Confirmed statically; HTTP reproduction not run  
**Confidence:** High

**Affected files**

- `server/routes/userRoutes.ts`
- `server/middleware/auth.ts`
- `server/publicData.ts`
- `src/types.ts`

**Evidence**

- `server/routes/userRoutes.ts:128–139` registers `GET /users/:id` without `requireAuth` and returns `safeUser(user)`.
- `server/middleware/auth.ts:185–189` removes only `password`, `knownDevices`, `sessionVersion`, and `activeSessionVersions`; other properties pass through.
- `src/types.ts:279–324` shows that user objects can include `email`, `mobile`, `role`, `earned`, `status`, `emailVerified`, `mobileVerified`, `isFlagged`, `flagReason`, `walletBalance`, `kycStatus`, and `notificationPreferences`.
- Contrast: `server/routes/userRoutes.ts:18–26` uses `sanitizePublicUser`; `server/publicData.ts:27–47` is an explicit allow-list projection.

**Impact**

Unauthenticated callers who know/guess a user ID can retrieve private contact, balance, account-status, flag/KYC, and notification-preference fields. The password itself is removed; the finding is not a password disclosure claim.

**Reproduction scenario**

Send unauthenticated `GET /api/users/<known-user-id>` and inspect whether fields beyond the public profile appear. Compare with `GET /api/users`.

**Minimal safe correction**

Make the endpoint public only through `isUserPublic` + `sanitizePublicUser`, or require authentication and return a role- and relationship-specific projection. Never use `safeUser` as a public serializer.

## SB-35 — MEDIUM — Notification-preferences GET route is shadowed by the earlier dynamic user-ID route

**Verification status:** Confirmed from Express route order; browser reproduction not run  
**Confidence:** High

**Affected files**

- `server/routes/userRoutes.ts`
- `src/pages/SettingsPage.tsx`

**Evidence**

- `server/routes/userRoutes.ts:128–139` registers `GET /users/:id` before `:141–153` registers `GET /users/notification-preferences`.
- Express matches `/users/notification-preferences` to `:id` first; that handler looks up a user with ID `notification-preferences` and returns 404 without calling `next()`.
- `src/pages/SettingsPage.tsx:47–60` calls `GET /api/users/notification-preferences` to populate the settings UI.

**Impact**

The Settings page cannot load preferences through its intended GET endpoint and falls back to client defaults or stale state. The PATCH route is a separate method and is not shadowed by the GET handler.

**Reproduction scenario**

Sign in, load Settings, inspect the GET request to `/api/users/notification-preferences`; then compare the response with the actual saved preferences.

**Minimal safe correction**

Register the literal route before `/users/:id`, or constrain the dynamic route so it cannot match reserved path names. Add a route-order regression test.

## SB-36 — HIGH — Signup marks the email verified before the verification code is proven

**Verification status:** Confirmed statically; live email delivery and HTTP flow not run  
**Confidence:** High

**Affected files**

- `server/routes/authRoutes.ts`
- `src/server/siteSettings.ts`

**Evidence**

- `server/routes/authRoutes.ts:81–106` creates the user object with `emailVerified: true` at line 98 before verification.
- `server/routes/authRoutes.ts:111–120` subsequently creates and dispatches a signup verification code, implying proof is still pending.
- `server/routes/authRoutes.ts:157–190` separately implements code validation and sets `emailVerified = true` only after a correct code.
- `server/routes/authRoutes.ts:192–200` refuses to resend a verification code when `user.emailVerified` is already true.
- `src/server/siteSettings.ts:90–98,203–210` defines `requireEmailVerification` and related security policy settings; the wider settings wiring gap is also tracked in SB-09.

**Impact**

The verification state lies about ownership at account creation. Resend logic immediately treats the new account as already verified, making the code flow ineffective for records created by this route. Any policy that assumes `emailVerified` proves mailbox control is unsafe.

**Reproduction scenario**

Create an account using an email address that the requester does not control; inspect the persisted user immediately after signup and try the resend endpoint before submitting the code.

**Minimal safe correction**

Create the user with `emailVerified: false`; only set it true after a valid, unexpired, attempt-limited challenge is consumed. Gate actions requiring a verified address based on the authoritative persisted flag.

## SB-37 — HIGH — Authenticated email-change endpoint updates the login/recovery address without re-verifying ownership

**Verification status:** Confirmed statically; account-takeover scenario not dynamically reproduced  
**Confidence:** High

**Affected files**

- `server/routes/userRoutes.ts`
- `src/server/siteSettings.ts`

**Evidence**

- `server/routes/userRoutes.ts:99–125` validates the email is nonempty and unique (`:106–118`), then writes `user.email = normalizedEmail` and immediately saves at `:120–122`.
- The handler does not issue or consume a verification challenge for the new address and does not reset `emailVerified`/`verified` before returning.
- `src/server/siteSettings.ts:90–98` includes email-verification policy fields, but this handler does not use them.

**Impact**

A user with a valid session can redirect the account email/recovery destination to an address they have not demonstrated control over. The old verified state can remain attached to the new address.

**Reproduction scenario**

Authenticate to an account and PATCH `/api/users/email` with a fresh address that you cannot access. Check whether it is stored and still marked verified without a challenge.

**Minimal safe correction**

Use a pending-email field and a challenge bound to user ID + new address; atomically swap the address and set verified only after proof. Consider reauthentication for identity changes and notify the old address.

## SB-38 — HIGH — Dedicated Admin Payouts tab is a local-state demo, not connected to its financial API

**Verification status:** Confirmed statically; no browser/payment sandbox run  
**Confidence:** High

**Affected files**

- `src/pages/AdminPage.tsx`
- `src/components/admin_modules/AdminPayoutsModule.tsx`
- `server/routes/financialRoutes.ts`
- `src/components/UserWalletsLedgerModule.tsx`

**Evidence**

- `src/pages/AdminPage.tsx:497–500` renders `<AdminPayoutsModule />` with no props.
- `src/components/admin_modules/AdminPayoutsModule.tsx:9–21` makes data/callbacks optional and defaults to an empty local array.
- `src/components/admin_modules/AdminPayoutsModule.tsx:84–104` changes only React state and displays success toasts; callback props are absent, and “process” never calls a callback.
- `src/components/admin_modules/AdminPayoutsModule.tsx:130–137` “Refresh Queue” only displays a toast.
- Backend actions exist at `server/routes/financialRoutes.ts:1303–1307`; in contrast, `src/components/UserWalletsLedgerModule.tsx:59–80` fetches the payout list, showing the app has a separate connected financial view.

**Impact**

The dedicated tab can display “approved”, “processed”, or “rejected” success toasts without changing the database, escrow/ledger, or payout state. Reloading loses the local changes. Operators may mistakenly believe funds were actually disbursed or returned.

**Reproduction scenario**

Open Admin → Payouts, run an action, observe the toast, reload the page, then query `/api/admin/finance/payouts` and compare the durable status.

**Minimal safe correction**

Make this module use the same API-backed data/actions as the financial ledger module. Await server success before updating state or showing a success message; refresh from authoritative data.

## SB-39 — HIGH / CONDITIONAL — dotenv is loaded after static imports that capture secrets and cloud bucket configuration

**Verification status:** Import-order defect confirmed; impact depends on deployment environment and was not dynamically reproduced  
**Confidence:** Medium-High, conditional on how deployment injects env

**Affected files**

- `server.ts`
- `server/middleware/auth.ts`
- `server/cloudStorage.ts`
- `server/services/authService.ts`
- `package.json`

**Evidence**

- `server.ts:7–22` statically imports the application modules; `dotenv.config()` does not execute until `server.ts:83`.
- `server/middleware/auth.ts:8–17` computes production mode and captures `JWT_SECRET` at module evaluation, falling back to a hard-coded internal key if no environment value is visible at that moment (or throwing in detected production).
- `server/cloudStorage.ts:5–7` captures the bucket name at module evaluation.
- `server/services/authService.ts:41–43` also captures device-verification configuration at module load.
- `package.json` has no `start` script or explicit bootstrap that loads `.env` before importing the server graph.

**Impact**

If deployment relies on `.env` rather than injecting settings before Node starts, secrets/configuration may be read too early. In production this can prevent startup; outside production a configured JWT secret may be silently ignored in favor of the fallback, and cloud uploads may target the default bucket.

**Reproduction scenario**

Start with a clean shell where the variables exist only in `.env`, including `JWT_SECRET`/bucket settings; compare the loaded module values and token behavior with the intended config. Do not test against production credentials.

**Minimal safe correction**

Load environment before application imports (for example Node `--env-file`, a bootstrap entry that loads dotenv then dynamically imports the app, or deployment-level env injection). Fail closed if required secrets are unavailable.

## SB-40 — HIGH / CONDITIONAL — Caller-controlled payout ID can collide with an existing payout and the second UPSERT rewrites its identity/history

**Verification status:** Confirmed write-path mismatch statically; exploitation depends on knowing/reusing an existing payout ID and was not dynamically reproduced  
**Confidence:** High for unsafe ID/write design; collision scenario conditional

**Affected files**

- `server/services/payoutService.ts`
- `server/services/financialService.ts`
- `server/db/migration.sql`

**Evidence**

- `server/services/payoutService.ts:85–97` uses caller-provided `idempotencyKey`, header idempotency key, or `body.payoutId` as the payout row ID. The ID is not unconditionally generated server-side or ownership-checked.
- `server/services/financialService.ts:1031–1036` inserts the payout and on ID conflict updates only status/account details inside the wallet/ledger transaction.
- After that transaction returns, `server/services/payoutService.ts:99–120` performs a second UPSERT outside the transaction and on ID conflict overwrites `freelancer_id`, amount, method, status, creation date, and account details.
- `server/services/financialService.ts:1012–1015` treats the idempotency key as the financial replay guard, a separate concept from the payout row identifier.

**Impact**

A request that reuses a known payout ID with a distinct idempotency key can overwrite the existing payout row attribution/amount/status after the ledger transaction, desynchronizing payout history from the immutable journal. The second write can also reset a status after an interleaving admin action.

**Reproduction scenario**

In a disposable database, make a payout, then issue another request that supplies its ID as `payoutId`, a different amount/method and a new `idempotency_key`. Compare payout row, wallet movements, journals, and ledger references before/after.

**Minimal safe correction**

Generate payout IDs server-side; accept idempotency keys separately and uniquely constrain `(user_id, operation, key)`; reject IDs that already exist. Remove the second upsert or make the single record write part of the same transaction and preserve terminal history.

## SB-41 — MEDIUM — Payout compatibility aliases contain an extra `/api` prefix and resolve to `/api/api/...`

**Verification status:** Confirmed from router mount composition; request reproduction not run  
**Confidence:** High

**Affected files**

- `server/routes/financialRoutes.ts`
- `server/routes/index.ts`
- `server.ts`

**Evidence**

- `server.ts:124–125` mounts `apiRouter` at `/api`.
- `server/routes/index.ts:15–28` mounts `financialRouter` into `apiRouter` without another path prefix.
- `server/routes/financialRoutes.ts:1309–1311` declares paths starting `/api/admin/payouts/...`, so their effective paths become `/api/api/admin/payouts/...`.
- Canonical sibling routes at `server/routes/financialRoutes.ts:1303–1307` use `/admin/finance/payouts/...` and therefore resolve to `/api/admin/finance/payouts/...`.

**Impact**

The alias endpoints do not live at the apparent `/api/admin/payouts/...` path, so any client/integration using that path receives a 404. No frontend use of the faulty alias was found in this source scan; canonical routes exist.

**Reproduction scenario**

Call `/api/admin/payouts/<id>/approve` and `/api/api/admin/payouts/<id>/approve` in a test environment as an authorized admin.

**Minimal safe correction**

Remove the embedded `/api` prefix from router-relative paths or remove unused aliases. Add route-map tests that assert effective mounted paths.

## SB-42 — HIGH — Workspace invariant test explicitly permits multiple independent orders to share one WorkStream

**Verification status:** Confirmed test/spec contradiction; test suite not executed  
**Confidence:** High

**Affected files**

- `tests/phase3-workspace-invariants.test.ts`
- `src/server/workspaceService.ts`
- `server/routes/orderRoutes.ts`

**Evidence**

- `tests/phase3-workspace-invariants.test.ts:7–22` asserts two independent gig purchases get different workspaces.
- The same test then states at `:24–60` that “Multiple orders can reference the same Workspace” and asserts two different order IDs both bind to `sharedWs.workspaceId`.
- `src/server/workspaceService.ts:141–177` supports ensuring an order against an existing workspace, and `server/routes/orderRoutes.ts` accepts a supplied workspace ID for non-gig orders (covered in SB-06).

**Impact**

The test suite encodes mutually inconsistent invariants: separate gig purchases should not share a workspace, but “follow-on work” with a separate order is accepted as shared. This can let regression tests pass while violating the clarified product rule that each separately purchased gig/project has a distinct Order + WorkStream + Escrow.

**Reproduction scenario**

Run the workspace invariant test and inspect the asserted shared workspace/order IDs; compare its intended contract with the order-route tests for independent project purchases.

**Minimal safe correction**

Define separate concepts for a continuation within an existing order and a new funded order. Update the test to require a new workspace per new transaction; assert final submissions/revisions reuse the existing order/workspace.

## SB-43 — CRITICAL / RACE-CONDITIONAL — Concurrent payout approval can revert a completed payout to approved, enabling a second settlement

**Verification status:** Race path confirmed by control-flow inspection; concurrency reproduction not run  
**Confidence:** High for race window; dynamic race not run

**Affected files**

- `server/services/payoutService.ts`
- `server/services/financialService.ts`

**Evidence**

- `server/services/payoutService.ts:150–161` does `SELECT ... FOR UPDATE` via `pool.query`, then a separate unconditional `UPDATE payouts SET status = approved`; the statement-level transaction ends after the select, so the row lock is not retained through the later update.
- `server/services/payoutService.ts:167–188` separately checks and processes pending payouts under $500 without an atomic status compare-and-set around the route’s entire workflow.
- `server/services/financialService.ts:1142–1174` correctly locks the payout during settlement and accepts `pending` or `approved`, sets it `processed`, then creates a new settlement journal; there is no unique one-settlement constraint/idempotency key in that method.
- Interleaving: an approval handler reads `pending`; process handler settles it and sets `processed`; stale approval handler then writes `approved`. A later process request sees `approved`, and `settlePayout` accepts it again, potentially generating a second settlement journal/outflow.

**Impact**

A race can make the durable payout status disagree with the ledger’s already-settled state and may allow duplicate settlement accounting for the same payout. External gateway transfer execution still depends on the actual deployment/provider integration, but the internal ledger double-settlement path is plausible from the code.

**Reproduction scenario**

In a disposable Postgres environment, use barriers to pause `approvePayout` after its SELECT, process the same pending payout (amount under $500), then resume approval; inspect final status and call process again while approved. Assert only one settlement journal is possible.

**Minimal safe correction**

Perform all state transitions in a single database transaction with row locks and conditional updates. Add a durable one-time settlement marker/unique constraint keyed by payout ID, and make settlement idempotent regardless of row status. Never allow a stale approve update to overwrite a terminal state.

## Updated file-level issue index (all files with assigned findings)

The full 271-entry matrix is in `FivePa_File_Level_Split_Brain_Matrix_v3.csv`, and the full file list is in `FivePa_Master_File_Inventory_v3.md`. The following table shows each path with one or more issue assignments. Entries include tests/documentation where they expose or encode the split-brain behavior; being cited does not automatically mean the path itself is defective.

| File path | Finding IDs |
|---|---|
| `TABLE_OF_CONTENTS.md` | SB-20 |
| `README.md` | SB-20; SB-32 |
| `.env.example` | SB-21; SB-31 |
| `.gitignore` | SB-14 |
| `data/pgdata/base/4/2832` | SB-14 |
| `data/pgdata/base/4/3118` | SB-14 |
| `data/pgdata/base/4/3350` | SB-14 |
| `data/pgdata/base/4/3429` | SB-14 |
| `data/pgdata/base/4/3439` | SB-14 |
| `data/pgdata/base/4/2660` | SB-14 |
| `data/pgdata/base/4/2663` | SB-14 |
| `data/pgdata/base/4/2681` | SB-14 |
| `data/pgdata/base/4/2679` | SB-14 |
| `data/pgdata/base/4/2680` | SB-14 |
| `data/pgdata/base/4/2678` | SB-14 |
| `data/pgdata/base/4/2701` | SB-14 |
| `data/pgdata/base/4/2696` | SB-14 |
| `data/pgdata/base/4/2693` | SB-14 |
| `data/pgdata/base/4/2690` | SB-14 |
| `data/pgdata/base/4/2703` | SB-14 |
| `data/pgdata/base/4/2831` | SB-14 |
| `data/pgdata/base/4/2835` | SB-14 |
| `data/pgdata/base/4/2836` | SB-14 |
| `data/pgdata/base/4/2837` | SB-14 |
| `data/pgdata/base/4/2839` | SB-14 |
| `data/pgdata/base/4/3081` | SB-14 |
| `data/pgdata/base/4/3119` | SB-14 |
| `data/pgdata/base/4/3164` | SB-14 |
| `data/pgdata/base/4/3433` | SB-14 |
| `data/pgdata/base/4/3431` | SB-14 |
| `data/pgdata/base/4/2838` | SB-14 |
| `docs/GETTING_STARTED.md` | SB-13; SB-20; SB-32 |
| `docs/SENIOR_REVIEW_CHECKLIST.md` | SB-13; SB-20; SB-22 |
| `package.json` | SB-13; SB-20; SB-22; SB-32; SB-33; SB-39 |
| `server/cloudStorage.ts` | SB-07; SB-24; SB-39 |
| `server/jobs/backgroundJobs.ts` | SB-07; SB-24 |
| `server/access.ts` | SB-07; SB-23 |
| `scripts/verify-build.mjs` | SB-13; SB-20; SB-33 |
| `server/db/migration.sql` | SB-04; SB-05; SB-16; SB-19; SB-40 |
| `server/db/postgresStore.ts` | SB-04; SB-05; SB-07; SB-15; SB-19; SB-31 |
| `server/middleware/auth.ts` | SB-21; SB-30; SB-34; SB-39 |
| `server/routes/adminRoutes.ts` | SB-08; SB-09; SB-15; SB-31 |
| `server/routes/authRoutes.ts` | SB-09; SB-36 |
| `server/publicData.ts` | SB-26; SB-34 |
| `server/routes/gigRoutes.ts` | SB-26 |
| `server/routes/index.ts` | SB-41 |
| `server/routes/financialRoutes.ts` | SB-01; SB-02; SB-10; SB-12; SB-38; SB-41 |
| `server/routes/orderRoutes.ts` | SB-01; SB-02; SB-03; SB-05; SB-06; SB-25; SB-26; SB-27; SB-28; SB-30; SB-42 |
| `server/routes/proposalRoutes.ts` | SB-02; SB-03; SB-05; SB-16; SB-28 |
| `server/routes/userRoutes.ts` | SB-34; SB-35; SB-37 |
| `server/services/authService.ts` | SB-09; SB-39 |
| `server/routes/workstreamRoutes.ts` | SB-02; SB-05; SB-06; SB-07; SB-12; SB-18; SB-23; SB-24; SB-28; SB-30 |
| `server/services/financialService.ts` | SB-02; SB-03; SB-04; SB-05; SB-08; SB-11; SB-12; SB-15; SB-40; SB-43 |
| `server/services/payoutService.ts` | SB-04; SB-08; SB-40; SB-43 |
| `server/websocket.ts` | SB-17; SB-21 |
| `server/services/workstreamService.ts` | SB-07; SB-18; SB-23; SB-24 |
| `server/services/orderService.ts` | SB-03; SB-16; SB-25; SB-26 |
| `server.ts` | SB-13; SB-21; SB-32; SB-39; SB-41 |
| `src/components/SiteFeeSettingsModule.tsx` | SB-01; SB-02; SB-29 |
| `src/components/UserWalletsLedgerModule.tsx` | SB-38 |
| `src/components/admin_modules/AdminPayoutsModule.tsx` | SB-38 |
| `src/components/gigs/GigDetailView.tsx` | SB-01; SB-02; SB-25 |
| `src/components/marketplace/ProjectDetailView.tsx` | SB-02 |
| `src/components/workstream/StartWorkstreamModal.tsx` | SB-27 |
| `src/hooks/workstream/useWorkstreamActions.ts` | SB-27 |
| `src/pages/AdminPage.tsx` | SB-38 |
| `src/pages/SettingsPage.tsx` | SB-35 |
| `src/server/financeLedger.ts` | SB-02; SB-08; SB-12 |
| `src/server/paymentGateways.ts` | SB-10; SB-15; SB-31 |
| `src/server/workspaceService.ts` | SB-05; SB-06; SB-42 |
| `src/shared/fees.ts` | SB-01; SB-02; SB-11; SB-12; SB-29 |
| `src/server/siteSettings.ts` | SB-01; SB-02; SB-08; SB-09; SB-15; SB-28; SB-29; SB-36; SB-37 |
| `src/types.ts` | SB-34 |
| `tests/concurrency-race-stress.test.ts` | SB-16; SB-22 |
| `tests/fees.test.ts` | SB-01; SB-13 |
| `tests/fee-wiring.test.ts` | SB-13; SB-25; SB-33 |
| `tests/phase3-workspace-invariants.test.ts` | SB-06; SB-42 |
| `tests/security.test.ts` | SB-13 |
| `tests/webhook.test.ts` | SB-10; SB-22 |
| `tests/workstream.test.ts` | SB-07; SB-18; SB-22; SB-24 |
| `data/pgdata/PG_VERSION` | SB-14 |
| `data/pgdata/base/1/112` | SB-14 |
| `data/pgdata/base/1/113` | SB-14 |
| `data/pgdata/base/1/1247` | SB-14 |
| `data/pgdata/base/1/1247_fsm` | SB-14 |
| `data/pgdata/base/1/1247_vm` | SB-14 |
| `data/pgdata/base/1/1249_vm` | SB-14 |
| `data/pgdata/base/1/1249_fsm` | SB-14 |
| `data/pgdata/base/1/1249` | SB-14 |
| `data/pgdata/global/pg_internal.init` | SB-14 |
| `data/pgdata/pg_multixact/offsets/0000` | SB-14 |
| `data/pgdata/pg_subtrans/0000` | SB-14 |
| `data/pgdata/pg_logical/replorigin_checkpoint` | SB-14 |
| `data/pgdata/base/5/pg_internal.init` | SB-14 |
| `data/pgdata/global/pg_control` | SB-14 |
| `data/pgdata/pg_xact/0000` | SB-14 |
| `data/pgdata/postmaster.pid` | SB-14 |
| `data/pgdata/pg_wal/000000010000000000000001` | SB-14 |
| `vite.config.ts` | SB-32 |


## Updated remediation order

1. **P0 — Fix user-data exposure:** replace the unauthenticated `safeUser` response in `server/routes/userRoutes.ts` with a public allow-list projection and add privacy tests.
2. **P0 — Fix payout race and identity integrity:** in `server/services/payoutService.ts` and `server/services/financialService.ts`, make payout state transitions atomic, immutable by ID, and idempotent for settlement; remove the second conflicting UPSERT.
3. **P0 — Fix the main gig purchase blocker:** resolve SB-25 (`freelancerId` vs `freelancer_id`) and simultaneously enforce gig publication/moderation eligibility.
4. **P0 — Correct fees everywhere:** resolve SB-01/SB-02 and ensure checkout, escrow, ledger, refunds, invoices, payout calculation, and admin preview share the approved fee rule.
5. **P1 — Restore identity verification:** create signup users as unverified and require proof for email changes; wire policy settings into enforcement.
6. **P1 — Fix route wiring:** register `/users/notification-preferences` before `/:id`; correct the duplicated `/api` alias path.
7. **P1 — Remove fake admin payout actions:** connect the payouts tab to the authenticated server API and only show success after server confirmation.
8. **P1 — Fix workspace contract:** change `tests/phase3-workspace-invariants.test.ts` and route/service logic so each new funded transaction gets its own workspace; an existing order's delivery/revision must reuse that same order/workspace.
9. **P1 — Fix environment bootstrap:** load environment variables before importing modules that capture secrets/bucket names.
10. **P2 — Build a reproducible pipeline:** make test commands runnable from a clean checkout, run typecheck/build and test suites, then add database-backed E2E/fault-injection for each financial workflow.

## Minimum regression tests added to the release gate

- Unauthenticated `GET /api/users/:id` must never return email, mobile, balance, KYC status, internal flags, or preference data.
- `GET /api/users/notification-preferences` must hit the literal route and return the authenticated user's stored values.
- Signup remains `emailVerified=false` until a correct, unexpired code is consumed; resend and login verification policies must reflect persisted state.
- Changing email enters a pending-verification state and cannot silently preserve old `emailVerified=true`.
- Admin payout buttons invoke the API; state persists after reload; failed requests do not show success.
- Submit two independent payout requests with same/colliding `payoutId` and different idempotency keys; the prior payout's owner/amount/history must never change.
- Force an approval-vs-processing interleaving with barriers; at most one settlement journal per payout ID is allowed, and terminal status cannot revert.
- Test canonical effective route paths to catch `/api/api/...` mistakes.
- Assert every new Order has its own WorkStream and Escrow; final invoice/revision for an existing order reuses them.
- Boot with variables only in `.env` in a disposable environment; verify the configured JWT secret and cloud bucket are honored before modules initialize.

## Full previous report and historical material

The entire Version 2 master report follows below without intentional edits. It already consolidates the first deep audit, the prior combined report, SB-01 through SB-33, earlier F-01 through F-11 mapping, the previous matrix, and the full original ZIP inventory. It is preserved verbatim to avoid silently dropping earlier findings. Use the v3 file-level CSV and inventory for the current complete issue IDs.

---


# Historical Version 2 Master Report (preserved in full)

# FivePa Master Advanced Split-Brain Audit — Version 2

**Latest source archive:** `fivepa-freelance-marketplace (4)(1).zip`  
**Previous archive name:** `fivepa-freelance-marketplace (4).zip`  
**SHA-256:** `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`  
**Audit date:** 24 October 2026  
**Consolidation:** incorporates the earlier 11-finding baseline report and the 22-finding combined report, then adds 11 new source-level findings and a master per-file issue matrix.  
**Result:** 33 unique numbered findings (SB-01 through SB-33). The baseline report’s F-01 through F-11 overlap the consolidated SB findings and are preserved as historical text at the end, not counted as extra unique findings.

## Master verdict

**Production release recommendation: HOLD until all Critical findings are fixed and retested, and High findings are either resolved or explicitly accepted with evidence.** The most urgent new finding is `SB-25`: `server/services/orderService.ts` returns `freelancerId`, but `server/routes/orderRoutes.ts` validates `freelancer_id`, so the normal gig-order path rejects the selected seller before escrow funding. Other high-impact findings concern payout idempotency, escrow/order rollback, payment checkout, configuration persistence, cloud-file attachment validation, and the possibility of accepting a new funded WorkStream order while an account is restricted.

The most important fee split-brain remains the same: expected FivePa policy is a 20% freelancer commission, 5.5% client service fee on the gig price, and an extra $3.50 only when the gig price is strictly below $200. The implementation defaults and tests currently encode 1% + $1, with the percentage fee disappearing at $200 or above. Correct the executable paths and assertions, not only comments.

## Provenance / fresh ZIP check

The SHA-256 of the latest uploaded archive is `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`. It matches the earlier ZIP byte-for-byte, so there is no new code delta between those two filenames. The latest ZIP was extracted and inspected again. The archive contains **271 files** (excluding directory entries); `data/pgdata/` is included. The prior combined report’s SB-01 to SB-22 findings are preserved below, then new SB-23 to SB-33 findings follow.

## Issue directory — all 33 findings

| ID | Severity | Split-brain issue | Verification status |
|---|---|---|---|
| SB-01 | CRITICAL | Fee policy/defaults and assertions conflict with required 20% / 5.5% / $3.50 policy | Confirmed statically |
| SB-02 | CRITICAL | Fee math and financial breakdown have multiple sources of truth | Confirmed statically |
| SB-03 | HIGH | Generic project order not bound to buyer-owned project/accepted proposal | Confirmed statically |
| SB-04 | CRITICAL | Payout idempotency replay can create extra pending payout row | Confirmed statically; runtime not reproduced |
| SB-05 | CRITICAL | Cleanup can delete order after escrow transaction committed | Confirmed failure window; fault injection not run |
| SB-06 | HIGH | Separate transaction can reuse a WorkStream | Confirmed statically |
| SB-07 | HIGH | Seven-day cleanup deletes referenced file metadata and does not delete GCS object | Confirmed statically; storage not run |
| SB-08 | HIGH | Payout settings not all enforced by PostgreSQL route | Confirmed statically |
| SB-09 | HIGH | Registration/password/email/KYC/security settings not wired consistently | Confirmed statically |
| SB-10 | HIGH / RELEASE BLOCKER IF LIVE PAYMENTS CLAIMED | Checkout is mock; provider gateway test explicitly says live handshake not activated | Confirmed statically |
| SB-11 | MEDIUM / CONDITIONAL | Falsy fallback may convert zero commission to 20 depending driver value type | Conditional static risk |
| SB-12 | HIGH | Escrow top-up recomputes fees on increment under default rules | Confirmed statically |
| SB-13 | CRITICAL | Test/build workflow and readiness evidence are not reproducible | npm test fails; build/lint unavailable in extracted env; build pipeline gap statically confirmed |
| SB-14 | HIGH | PostgreSQL runtime files included in source archive | Confirmed archive contents; sensitivity unknown |
| SB-15 | HIGH | Settings success response precedes durable persistence | Confirmed statically |
| SB-16 | HIGH / CONDITIONAL | Proposal acceptance lock per proposal, not project; project status can race | Confirmed statically; race test not run |
| SB-17 | MEDIUM | WebSocket query token may be recorded by intermediary logs | Confirmed risk pattern |
| SB-18 | MEDIUM | Upload extension allowlist is not enforced by endpoint | Confirmed statically |
| SB-19 | HIGH | Database referential integrity is largely app-level | Confirmed schema scan |
| SB-20 | MEDIUM | Docs and readiness checklist conflict with files and scripts present | Confirmed statically |
| SB-21 | MEDIUM | Production auth/headers/proxy posture needs additional hardening validation | Part static, part unverified |
| SB-22 | HIGH | Full end-to-end pass cannot be claimed; critical suites not run | Observed testing limitation |
| SB-23 | HIGH | Duplicate WorkStream validators disagree and do not enforce uploader/target binding | Confirmed statically |
| SB-24 | HIGH | GCS-only upload path conflicts with validators that require local files | Confirmed statically; cloud execution not run |
| SB-25 | CRITICAL | Gig order route uses `freelancer_id` on a normalized object with `freelancerId`; rejects normal gig purchase | Deterministic static defect |
| SB-26 | HIGH / LATENT | Order route lacks published/moderation eligibility check for gig purchase | Missing guard confirmed; currently masked by SB-25 |
| SB-27 | MEDIUM | Custom WorkStream turnaround selected in UI is ignored by backend | Confirmed statically |
| SB-28 | MEDIUM | Escrow protection setting uses live value for proposals but default for generic/gig orders | Confirmed statically |
| SB-29 | MEDIUM | Admin fee simulator implements different service-fee conditions from fee helper | Confirmed statically |
| SB-30 | HIGH | Restricted account can accept some WorkStream offers that create a new funded order | Control-flow gap confirmed; runtime not run |
| SB-31 | HIGH | Gateway encryption exception returns plaintext secret and can persist it in production | Confirmed statically; stored deployment data not inspected |
| SB-32 | HIGH | npm run dev launches Vite only, without Express startup or /api proxy | Confirmed scripts/config |
| SB-33 | MEDIUM | Fee wiring source test can false-pass and silently skip missing server bundle checks | Confirmed statically; test not run |

## How to interpret this audit

- **Confirmed statically / deterministic source defect:** the cited source directly demonstrates the mismatch, but production execution may still be untested.
- **Observed command failure:** the command was executed in the extracted archive and returned the stated failure.
- **Conditional / latent:** the missing check is visible, but another defect currently blocks the affected path or a runtime precondition is necessary.
- **Unverified:** not a PASS. No live browser, production PostgreSQL, cloud bucket, or payment provider was run.
- Files without an assigned issue in the master matrix are not certified clean; this is not a claim that every possible behavior was exhaustively executed.

---

# Part I — Previously consolidated audit (SB-01 to SB-22; full report preserved)

# FivePa / WorkPerHour — Combined Advanced Split-Brain Audit

**Report version:** Combined prior audit + advanced follow-up source inspection  
**Audit date:** 24 October 2026  
**Primary archive:** `fivepa-freelance-marketplace (4)(1).zip`  
**Earlier archive name:** `fivepa-freelance-marketplace (4).zip`  
**SHA-256:** `b7d037aa2e4a6337be1afc10904125a3c5166e797937ecfa500c12ca49e89302`  
**Archive identity check:** Both archive names have the exact same SHA-256, so the latest upload is the same binary content as the archive reviewed earlier; no source-code delta exists between those two ZIPs.  
**Application shape:** React/TypeScript + Vite frontend, Express/TypeScript backend, PostgreSQL persistence, WebSocket layer, financial ledger/escrow services, and WorkStream flows.  
**Audit mode:** Static source review, cross-file consistency analysis, targeted command verification. No production data was modified and no code was changed.

---

## 1. Executive verdict

**Release recommendation: HOLD production release until the Critical and High findings below are fixed and retested.** This report combines the earlier 11-finding report with a further investigation of financial and operational paths. The additional review found more concrete problems, including a payout idempotency split-brain, insufficient server-side binding between project orders and accepted proposals, a referenced-file cleanup defect, ignored payout/security configuration, and a checkout endpoint that does not create a real payment-provider session.

The most consequential findings are:

1. **Fee policy is not what the business rule says.** `src/shared/fees.ts` defaults to 20% commission, 1% service fee, and $1 small-order fee; the required policy is 20%, 5.5%, and $3.50 only for prices strictly below $200.
2. **Repeated withdrawals can make the financial engine and payout table disagree.** When a client omits an idempotency key, the route generates a new payout ID but the financial layer reuses an idempotency key based on freelancer + amount + method. A repeat request can therefore insert a second pending payout row without creating a second matching debit/hold.
3. **The generic order endpoint is not a trustworthy project acceptance boundary.** For non-gig orders it accepts a request-supplied amount and seller, and the project branch does not verify project ownership or require an accepted proposal.
4. **Escrow funding and later order persistence are not one atomic operation.** A failure after the financial transaction commits can trigger cleanup that deletes the order but does not reverse the already committed escrow/wallet/ledger records.
5. **WorkStream uploads are deleted after seven days without checking whether the files are referenced by active orders, messages, invoices, or deliverables.** The cleanup runs hourly.
6. **Admin settings imply protections the production paths do not enforce.** Minimum/maximum/daily payout limits, payout-method choices, KYC, registration restrictions, email verification, and password minimum length are not consistently connected to their actual handlers.
7. **The repository cannot currently demonstrate a clean test/build pass.** `npm test` fails because the script is missing; `npm run build` fails because `vite` is not installed in the extracted checkout; `npm run lint` fails on missing `vite/client` type definitions. The documentation nevertheless claims 30/30 tests pass and marks missing test files as PASS.
8. **The source ZIP contains a raw PostgreSQL data directory.** It includes `data/pgdata/global/pg_control`, a WAL segment, and `postmaster.pid`. Actual sensitive records were not decoded, so data exposure is a risk to investigate, not a confirmed disclosure of specific records.

The archive has substantial implementation work and some good security controls, but these are offset by cross-layer disagreements. Passing a single test suite would not establish correctness because the default test workflow does not exist and at least one fee test asserts the incorrect policy.

---

## 2. Source provenance, scope, and confidence

### 2.1 Archive inventory

| Inventory item | Observed value |
|---|---:|
| ZIP entries, including directories | 320 |
| Files extracted | 271 |
| Non-PostgreSQL-data files | 226 |
| Decodable UTF-8 text/source files outside `data/pgdata/` | 224 |
| Approximate lines across those text files | 64,601 |
| Files beneath `data/pgdata/` | 45 |
| Bytes beneath `data/pgdata/` | 18,569,178 |
| `data/pgdata/global/pg_control` | 8,192 bytes |
| `data/pgdata/pg_wal/000000010000000000000001` | 16,777,216 bytes |
| `data/pgdata/postmaster.pid` | Present, 55 bytes |

### 2.2 Checks performed against the actual uploaded archive

- Extracted the uploaded ZIP into a fresh directory and verified file names and key source lines from that extraction.
- Compared the hash with the earlier ZIP name; they are byte-for-byte identical.
- Attempted `npm test -- --run`: **exit 1**, `Missing script: "test"`.
- Attempted `npm run build`: **exit 127**, `vite: not found`.
- Attempted `npm run lint`: **exit 2**, TypeScript could not find the `vite/client` type definition.
- Confirmed the extracted archive has no `node_modules/.bin/vite` and no `node_modules/.bin/tsx`.
- Inspected source logic across shared fees, settings, order creation, proposal acceptance, payout handling, PostgreSQL financial transactions, WorkStream uploads, auth, WebSocket authentication, SSR data sanitization, migrations, tests, build scripts, and documentation.

### 2.3 Verification labels

- **Confirmed statically:** the cited source code/configuration has the behavior described.
- **Observed command failure:** the command was attempted against the extracted archive and failed as stated.
- **Conditional runtime risk:** the code exposes a failure window or race, but reproducing it needs a running PostgreSQL/browser/provider environment.
- **Unverified:** the system has not been run end-to-end; this is not a PASS.

This is a substantially deeper static cross-file audit, but it is **not truthful to claim that every runtime state and every possible line interaction has been exhaustively executed**. The 224 text files / ~64,601 lines were inventoried, while the intensive path-by-path analysis below concentrates on critical finance, order, auth, WorkStream, build, and persistence flows. No live payment, browser, cloud-storage, concurrent-database, or deployment test could be performed in this environment.

---

# 3. Findings — detailed evidence and fixes

## SB-01 — CRITICAL — Fee configuration contradicts the agreed FivePa fee policy

**Status:** Confirmed statically.  
**Files:**
- `src/shared/fees.ts:5–21, 63–90`
- `src/server/siteSettings.ts:145–153`
- `tests/fees.test.ts:1–4, 26–45, 47–78, 86`

**Evidence**

`src/shared/fees.ts:16–21` defines:

- `commissionPercent: 20`
- `buyerFeePercent: 1.0`
- `smallOrderFee: 1.0`
- `smallOrderThreshold: 200`

`src/shared/fees.ts:67–68` says the client service fee applies only when the order is under $200 and is zero at/above $200. `src/server/siteSettings.ts:147–149` claims in comments that the service fee is 5.5% and the flat fee is $3.50, but obtains both numeric values from those incorrect defaults. `tests/fees.test.ts:1` advertises the intended 5.5%/$3.50 policy, while its assertions at lines 29–44 and 57 explicitly validate 1%/$1 and no service fee at $200 or more.

**Policy expected for FivePa**

- Freelancer commission: 20% of gig price; freelancer receives 80%.
- Client service fee: 5.5% of gig price, added on top.
- Additional small-order fee: $3.50 only when gig price is **strictly below $200**.
- Exactly $200: no $3.50 small-order fee, but the 5.5% service fee still applies.

**Concrete discrepancy**

For a $50 gig, the present defaults produce a $0.50 service fee + $1 flat fee = **$51.50** client total. The stated policy produces a $2.75 service fee + $3.50 small-order fee = **$56.25**. For a $200 gig, current defaults charge $200 total, while the stated policy produces $211 total.

**Impact:** checkout mispricing, incorrect platform income, mismatch between UI quote and money movement, misleading invoice totals, wrong full-refund fee reversal, and inaccurate seller/client finance reports. Existing unit tests can pass while preserving the wrong policy.

**Minimal safe fix:** change the canonical defaults and fee rules to the written policy, update tests to assert the intended values, and add the exact boundaries `$0.01`, `$199.99`, `$200.00`, `$200.01`, and a larger order. Correct comments only after correcting executable values.

---

## SB-02 — CRITICAL — Fee computation and fee records have multiple sources of truth

**Status:** Confirmed statically.  
**Files:**
- `src/shared/fees.ts:16–21, 70–90`
- `src/server/siteSettings.ts:278–314`
- `src/server/financeLedger.ts:212–264`
- `server/services/financialService.ts:568–613, 679–682, 826–860`
- `server/routes/orderRoutes.ts:357–379`
- `server/routes/proposalRoutes.ts:245, 278–290`
- `server/routes/workstreamRoutes.ts:843, 905, 956, 1013`
- `server/routes/financialRoutes.ts:213–214, 337–338, 721–728, 778–782, 1205–1207`

**Evidence**

- The shared fee defaults live in `src/shared/fees.ts`.
- Site settings build a separate runtime config in `src/server/siteSettings.ts:278–314` and push it to the legacy in-memory `financeLedger`.
- PostgreSQL escrow funding separately reads `site_settings` in `server/services/financialService.ts:568–580` and calculates actual funding fees at `:582`.
- `server/routes/orderRoutes.ts:357` stores the order’s displayed `feeBreakdown` using `DEFAULT_FEE_CONFIG`, then calls the PostgreSQL funding path at `:369–376`.
- Proposal and WorkStream offer paths set `feeBreakdown` using `financeLedger.quoteOrder(...)` (`server/routes/proposalRoutes.ts:245`; `server/routes/workstreamRoutes.ts:905, 956`).
- Reporting/invoice endpoints use `DEFAULT_FEE_CONFIG` fallbacks (`server/routes/financialRoutes.ts:337–338, 721–728, 778–782, 1205–1207`).

This creates at least four views of financial truth: site settings, in-memory quote engine, order-stored fee breakdown, and PostgreSQL escrow/ledger values. A site setting can affect the actual funding amount while the order object and invoices still use defaults or the legacy in-memory config. If an old order has no persisted `feeBreakdown`, invoices and reports can **recompute historical values under current defaults** instead of showing the actual values at purchase time.

**Impact:** an order can be funded at one amount and displayed/invoiced at another; admin dashboards can report revenues different from ledger movements; historical transactions can change appearance after a fee setting update.

**Minimal safe fix:** use one canonical server-only fee service; quote with the effective database configuration before funding; persist an immutable breakdown and fee-policy version on the order and escrow; use those persisted cents for invoice, refund, platform reports, and seller net. Do not recalculate a historical order from current settings.

---

## SB-03 — HIGH — Generic project order creation is not bound to project ownership or an accepted proposal

**Status:** Confirmed statically; impact depends on how the generic route is exposed to project/custom-order UI.  
**Files:**
- `server/routes/orderRoutes.ts:225–265, 277–318, 339–379`
- `server/routes/proposalRoutes.ts:195–245, 303–310`
- `server/services/financialService.ts:562–639`

**Evidence**

`POST /orders` is authenticated (`server/routes/orderRoutes.ts:226`) and correctly derives the buyer from the authenticated account at `:233–243`. For gig orders it resolves the actual gig price and validates that the gig belongs to the selected seller (`:260–265`). However, for a non-gig order, `rawAmount` starts as `Number(req.body.amount)` at `:257`. The project lookup at `:277–283` only reads `deadline_days`; it does not verify that the project belongs to the buyer, that the chosen seller submitted an accepted proposal, or that the submitted amount matches the proposal bid. Only the gig branch re-derives the amount and validates the seller relationship. The endpoint then creates and funds the order at `:339–379`.

By contrast, `server/routes/proposalRoutes.ts:195–245` is the dedicated proposal acceptance path and obtains seller and amount from the project/proposal records.

**Impact:** the API can create a funded order associated with an arbitrary `projectId` using a request-supplied seller and amount rather than the project’s accepted proposal. Even though the buyer pays their own funds, the resulting transaction can falsely represent a project contract, attach orders to the wrong project, and break project/proposal/order reconciliation.

**Minimal safe fix:** split API routes by business intent. A project purchase must be derived server-side from a valid accepted proposal (project owner, proposal owner, bid amount, delivery time, project state). A custom order must use a separately specified buyer-authorized workflow with explicit server-side limits. Reject arbitrary `projectId` + caller amount combinations.

**Regression scenario:** submit `POST /api/orders` as buyer A with an unrelated project ID, seller B, and an arbitrary amount; assert rejection unless there is a valid acceptance/custom-order authorization record.

---

## SB-04 — CRITICAL — Payout idempotency can create a pending payout row without its own debit/hold

**Status:** Confirmed statically; live reproduction needs a running PostgreSQL database.  
**Files:**
- `server/services/payoutService.ts:74–120, 167–188`
- `server/services/financialService.ts:1010–1058, 1142–1173`

**Evidence**

- `server/services/payoutService.ts:85` generates a random payout ID if the client supplies no idempotency key or payout ID.
- At `:86`, the fallback idempotency key is deterministic from freelancer ID + amount + payout method: `IDEMP-PAYREQ-${freelancerId}-${numAmount}-${rawMethod}`.
- `server/services/financialService.ts:1012–1015` returns the prior financial-idempotency result immediately when that key already exists, without creating a second wallet debit/hold or second payout journal.
- The route then always constructs a new record from the newly generated `id` at `server/services/payoutService.ts:99–107` and upserts it into `payouts` at `:109–120`, even if the financial service returned a prior result whose `payoutId` was different.
- Admin processing accepts pending payout rows (`server/services/payoutService.ts:167–188`) and `settlePayout` creates its own `PAY-<payout id>-SETTLED` journal (`server/services/financialService.ts:1142–1173`).

**Failure scenario**

1. A freelancer requests a $100 bank transfer without a caller-supplied idempotency key; random payout ID A is stored and $100 is reserved once.
2. The same request is sent again later; the default idempotency key matches, so the financial service returns the original result without another debit, but the route may generate payout ID B and insert a second pending payout record.
3. Administrators may now see and process two pending payout records even though only one corresponding request debit/hold exists. Repeating the same amount/method can also keep reusing the old idempotency key after a previous request has finished.

**Impact:** duplicate or phantom payout rows, financial ledger/payout-table divergence, and potential overpayment if operators process the extra row. This is a money-movement correctness bug, not just a cosmetic duplicate.

**Minimal safe fix:** require a client idempotency key for a withdrawal and return the same payout row ID on replay; persist an idempotency-key-to-payout-ID mapping inside the same DB transaction as the payout row and wallet/ledger movement; validate that a replay has the same freelancer/amount/method/account details; reject key reuse with different inputs. If a replay is detected, return the exact existing payout object and **do not insert another row**.

---

## SB-05 — CRITICAL — Order cleanup can delete an order after escrow funding has committed

**Status:** Confirmed failure window in code; dynamic fault injection not performed.  
**Files:**
- `server/routes/orderRoutes.ts:362–395`
- `server/routes/proposalRoutes.ts:267–300`
- `server/routes/workstreamRoutes.ts:961–984`
- `server/services/financialService.ts:562–639`
- `server/db/migration.sql:558–575` (escrow has no foreign key back to order)

**Evidence**

The order route persists the order, calls `fundOrderEscrowWithEvent` (`server/routes/orderRoutes.ts:369–376`), updates the order status, then calls `store.saveOrder(enriched)` again at `:378–380`. If the second save throws, the catch at `:381–395` deletes the order and messages and may delete the workspace, but it does not reverse the already committed escrow, wallet debit/hold, wallet movement, ledger journal/entries, or idempotency row created by `server/services/financialService.ts:597–634`.

The same pattern exists in proposal acceptance: the funding call is at `server/routes/proposalRoutes.ts:278–286`; if post-funding order save at `:288–290` fails, catch cleanup at `:291–300` deletes the order, offer, messages, and workspace but does not reverse financial state. Follow-on order creation in `server/routes/workstreamRoutes.ts:966–983` similarly deletes order/messages following a funding-related error, without an explicit financial reversal in that catch.

The migration defines `escrows.order_id` as a primary key but no `REFERENCES orders(id)` constraint (`server/db/migration.sql:558–575`), so an orphaned escrow is not prevented by the database.

**Impact:** if any post-funding persistence operation fails, a client’s funds can remain debited/on hold and the escrow/ledger can exist after the order is deleted. Recovery and reconciliation become manual and error-prone.

**Minimal safe fix:** make order creation, order-state transition, escrow, wallet movements, ledger entries, and idempotency persistence one database transaction, or use a durable state machine/outbox with explicit “funding pending/funded/compensation pending” statuses. Never delete an order after funding commit unless a proven compensating ledger transaction has successfully reversed all financial effects. Add fault-injection tests after every DB write boundary.

---

## SB-06 — HIGH — A new transaction can reuse an existing WorkStream, contrary to the transaction-isolation invariant

**Status:** Confirmed source behavior and cross-file policy mismatch.  
**Files:**
- `server/routes/orderRoutes.ts:292–318`
- `src/server/workspaceService.ts:141–175, 178–192`
- `server/routes/workstreamRoutes.ts:932–963`
- `tests/phase3-workspace-invariants.test.ts:24–60`

**Evidence**

`server/routes/orderRoutes.ts:292–301` creates a new workspace for gig orders, but for non-gig orders `:302–308` accepts `req.body.workspaceId`, then checks only that the existing workspace has the same buyer and seller. `src/server/workspaceService.ts:141–159` appends the new order ID to the existing workspace’s `orderIds`. The follow-on order path in `server/routes/workstreamRoutes.ts:939–959` explicitly sets `workspaceId: order.workspaceId`, then creates/funds a new order at `:961–977`.

`tests/phase3-workspace-invariants.test.ts:24–60` tests/endorses reuse of a workspace with multiple order IDs. That contradicts the established product invariant: every separately purchased Gig or separately accepted Project must have its own Order + WorkStream + Escrow; a final invoice/submission for an already existing order must reuse that same transaction, not create a new order.

**Impact:** messages, files, revisions, offers, and delivery histories can span separate financial transactions. Participants may not be able to tell which work item a message or file belongs to, while one workspace can represent multiple distinct escrow orders.

**Minimal safe fix:** enforce one-to-one Order↔WorkStream for new commercial transactions. Do not take an arbitrary workspace ID when creating a new order. For follow-on work, create a fresh Order + WorkStream + Escrow if the product rule is a separately sold project; for submissions/invoices on an existing order, update the same order and never create a new order. Rewrite the workspace-invariant test to encode the product rule rather than the current behavior.

---

## SB-07 — HIGH — WorkStream files are deleted after seven days without checking whether they are still referenced

**Status:** Confirmed statically; real browser/storage lifecycle not run.  
**Files:**
- `server/services/workstreamService.ts:30–40, 277–302`
- `server/jobs/backgroundJobs.ts:41–48`
- `server/routes/workstreamRoutes.ts:304–342`

**Evidence**

`server/services/workstreamService.ts:30` sets `WORKSTREAM_ABANDONED_UPLOAD_TTL_MS` to seven days. `cleanupAbandonedWorkstreamUploads()` (`:277–287`) walks all upload records and removes every record whose `createdAt` is older than the TTL; it does not check whether the file is attached to a message, invoice, delivery, revision, active order, or completed order. It deletes both the local file and its upload record (`:285–286`). The cleanup job is scheduled hourly in `server/jobs/backgroundJobs.ts:41–48`.

The file-serving route returns 404 when neither a local file nor an upload record exists (`server/routes/workstreamRoutes.ts:304–314`). For cloud-backed uploads, deleting the record can make the object inaccessible through this route even if the cloud object remains; the cleanup also does not invoke a cloud-object deletion in the shown code, creating an orphaned cloud object.

**Impact:** the platform may delete or hide a deliverable, client-provided brief, revision attachment, or invoice evidence after seven days, potentially while escrow/review/dispute obligations remain open. The default escrow-protection period is 14 days (`src/server/siteSettings.ts:152`), already longer than the upload TTL.

**Minimal safe fix:** cleanup must identify truly orphaned/unreferenced uploads, not use age alone. Store durable references from messages/deliverables/invoices to upload IDs, implement retention according to order/dispute/legal status, and delete local + cloud objects only after confirming no references. Add a test where an older-than-seven-days file referenced by an active order remains accessible.

---

## SB-08 — HIGH — Payout policy controls in site settings are not enforced by the PostgreSQL payout path

**Status:** Confirmed statically.  
**Files:**
- `src/server/siteSettings.ts:179–194`
- `server/services/payoutService.ts:74–97`
- `server/services/financialService.ts:1010–1025`
- `src/server/financeLedger.ts:904–914`

**Evidence**

Site defaults expose minimum withdrawal `$3`, maximum per transaction `$5,000`, daily withdrawal `$10,000`, manual-review threshold `$500`, and selectable payout methods (`src/server/siteSettings.ts:179–194`). But the production request path at `server/services/payoutService.ts:74–97` checks allowed methods against the static `DEFAULT_SITE_SETTINGS`, not the persisted current settings, and only validates that amount is finite and greater than zero. The PostgreSQL `requestPayout` path at `server/services/financialService.ts:1010–1025` checks idempotency and wallet balance but has no min/max/daily/KYC condition in this shown path. By contrast, the legacy in-memory engine checks minimum and maximum at `src/server/financeLedger.ts:911–914`; it explicitly refuses to act as the financial authority in production when `NODE_ENV=production` or `POSTGRES_URL` is set (`:221–224`).

**Impact:** operators may change these settings believing the production money path enforces them, while the actual database-backed withdrawal path behaves differently. A $0.50 withdrawal can be accepted where a $3 minimum is configured; changing payout methods in settings may not change backend eligibility; daily cumulative limits are not enforced by this request path.

**Minimal safe fix:** create a database-backed policy service and call it inside the same transaction that locks the wallet and books the payout. Enforce per-request min/max, daily aggregate limits under a lock/serializable transaction, method enablement, account ownership, KYC status, hold period, and approval thresholds. Do not rely on UI-only validation or an in-memory service excluded from production authority.

---

## SB-09 — HIGH — Registration and account-security settings are not wired into signup behavior

**Status:** Confirmed statically.  
**Files:**
- `src/server/siteSettings.ts:90–98, 203–211, 446–531`
- `server/routes/authRoutes.ts:43–55, 79–120, 144–150`

**Evidence**

Settings declare `allowNewRegistrations`, `requireEmailVerification`, `requireKycForPayouts`, `requireAdmin2FA`, `maxFailedLoginsLockout`, `sessionTimeoutMinutes`, and `minPasswordLength` (`src/server/siteSettings.ts:90–98, 203–211`). `updateFromFlatObject()` handles commission, marketplace, wallet, website and localization fields (`:449–527`) but does not update a `security` section. The signup handler does not consult `allowNewRegistrations`; it hardcodes a six-character minimum (`server/routes/authRoutes.ts:53–55`) despite the configured minimum of eight (`src/server/siteSettings.ts:210`). It creates the new user with `emailVerified: true` (`server/routes/authRoutes.ts:96–99`), then creates and dispatches a verification code at `:111–120`, and returns a token at `:144–150` without enforcing that verification before use.

**Impact:** admin-visible security settings can be inert. A future operator can believe registration is disabled, email verification is required, passwords need eight characters, KYC is required, or admin 2FA is mandatory when those settings are not actually wired through the corresponding controls.

**Minimal safe fix:** connect each supported setting to server-side enforcement, or remove/label unsupported settings as non-operative. New users should be unverified until successful verification; if verification is optional, the account must still not be marked verified just because signup succeeded. Add tests for each setting toggled both on and off.

---

## SB-10 — HIGH / RELEASE BLOCKER IF MARKETED AS LIVE — Gateway checkout is a mock session and webhook credits are not tied to a stored checkout intent

**Status:** Confirmed statically; no live gateway tested.  
**Files:**
- `server/routes/financialRoutes.ts:431–455, 457–500`
- `src/server/siteSettings.ts:219–221`
- `package.json` (provider SDKs are not listed in dependencies)

**Evidence**

`POST /payments/gateway/checkout` (`server/routes/financialRoutes.ts:431–455`) validates a positive amount, generates a random `chk_...` ID, and returns an internal `/checkout/success?...` URL at `:443–451`. It does not call a Stripe/Razorpay API, persist a provider payment intent, bind the session to a user/order in a durable row, or verify provider-side checkout status. Site defaults show gateway flags enabled and a masked `pk_test_...` key (`src/server/siteSettings.ts:219–221`).

The webhook does validate an HMAC with a shared secret and uses a constant-time comparison (`server/routes/financialRoutes.ts:457–472`), which is a positive control. However, after parsing the signed payload it takes `userId`, `amount`, and provider transaction/reference from the event (`:475–493`) and credits a deposit without looking up and reconciling a stored checkout intent, expected currency, exact expected amount, or payment status record tied to the checkout ID.

**Impact:** the checkout endpoint itself does not represent a real captured payment. If presented as live checkout, success redirects can mislead users and the application has no durable intent to reconcile against provider settlement. A signed event with unexpected metadata/amount would not be checked against an application-side expected payment record.

**Minimal safe fix:** integrate the actual provider SDK/API, persist a `payment_intent`/checkout record with immutable user/order/amount/currency/provider identifiers, verify provider-native webhook signatures, and perform an idempotent compare-and-set transition from pending to paid only after fetching/verifying the provider event. Credit exactly the stored amount, never an unchecked payload amount.

---

## SB-11 — MEDIUM / CONDITIONAL — Zero-commission fallback uses a falsy default and is driver-dependent

**Status:** Unsafe expression confirmed statically; whether it changes a live 0% row depends on the PostgreSQL adapter's NUMERIC return type and needs a targeted runtime test.  
**Files:**
- `src/shared/fees.ts:51–54`
- `server/services/financialService.ts:40–43, 612–613, 665–682`

**Evidence**

The shared validator permits `commissionPercent = 0` (`src/shared/fees.ts:51–54`) and the funding path persists the configured commission at `server/services/financialService.ts:612–613`. The escrow formatter uses `Number(r.commission_percent || 20)` at `:40`, and the release path uses `Number(escrow.commission_percent || 20.0)` at `:680`. If the field is represented as numeric `0`, JavaScript's `||` fallback changes it to 20. PostgreSQL `NUMERIC` columns are often returned as strings by the `pg` driver (where `'0.00'` is truthy), and the release path reads a fresh SQL row at `:665–670`; therefore, I am **not** claiming that the fallback definitely changes the live production value in this archive without verifying the actual adapter behavior.

**Impact:** if a configured zero reaches either expression as a JavaScript number, the fee policy changes from 0% to 20% at formatting/release. Even if the current adapter serializes it as a string, the expression remains fragile across mocks, PGlite/pg adapters, caches, and future refactors.

**Minimal safe fix:** use nullish checks (`??`) or explicit `null`/`undefined` checks; add a database-backed test that funds a 0% commission escrow and confirms the amount released is not reduced by commission.

---

## SB-12 — HIGH — Escrow top-up recomputes fees on the increment using defaults instead of the order’s original policy

**Status:** Confirmed statically; exact product intent for top-ups should be recorded.  
**Files:**
- `server/services/financialService.ts:826–860`
- `src/shared/fees.ts:70–90`

**Evidence**

`topUpEscrow()` locks an existing escrow at `server/services/financialService.ts:828–834`, then calculates fees with `calculateOrderFees(params.amount)` at `:846` using the function default config rather than loading persisted site settings or the original order’s fee policy. `params.amount` is the increment being added, not the order’s aggregated price. The computed service/flat fees are accumulated into the escrow at `:859–860`.

**Impact:** a small top-up can incur another $1 under current defaults even where the original order was above the threshold, the changed site setting may be ignored, and the escrow fee history can disagree with invoice/refund amounts. Under the intended 5.5%/$3.50 policy, the same wrong basis can create the wrong flat-fee application on incremental changes.

**Minimal safe fix:** specify whether a top-up is an additional charge on the same transaction or a new billable transaction. If the same order, use its immutable policy version and apply fees according to the defined top-up policy without accidentally reapplying a one-time order fee. Persist each top-up’s exact breakdown so refunds and audits can reverse it.

---

## SB-13 — CRITICAL — Clean build/test workflow is currently broken and readiness docs contain unsupported PASS claims

**Status:** Command failures observed against the freshly extracted archive; file discrepancies confirmed statically.  
**Files:**
- `package.json:1–20`
- `scripts/verify-build.mjs:4–20`
- `tests/security.test.ts` (imports root `../server.js`)
- `tests/fee-wiring.test.ts:13–26` and remaining test logic
- `docs/GETTING_STARTED.md:34–52, 72–86`
- `docs/SENIOR_REVIEW_CHECKLIST.md:8–39`
- Missing files: `server.js`, `tests/patch-verification.test.ts`, `tests/workstream-security.test.ts`, `src/components/workstream/WorkstreamChatTab.tsx`, `app/sitemap.ts`

**Observed command results**

| Command | Result | Evidence |
|---|---|---|
| `npm test -- --run` | Exit 1 | `Missing script: "test"` |
| `npm run build` | Exit 127 | script runs `vite build`; shell reports `vite: not found` |
| `npm run lint` | Exit 2 | TypeScript error: cannot find type definition file `vite/client` |

`package.json` includes `dev`, `build`, `preview`, `clean`, and `lint`, but no `test` or `start`. `build` is only `vite build`; it does not compile `server.ts` to root `server.js`. `scripts/verify-build.mjs:4–9` expects root `server.js`, yet it is absent from this ZIP. The security test imports that missing artifact. `docs/SENIOR_REVIEW_CHECKLIST.md:11,13,15` asserts PASS based on `tests/patch-verification.test.ts` and `tests/workstream-security.test.ts`, both absent from the archive. `docs/GETTING_STARTED.md:42–52` says `npm run dev` starts the full-stack server and `npm test` runs 30 tests, but the package does not define those behaviors. The documentation also references `src/components/workstream/WorkstreamChatTab.tsx` (`:72–76`), which is absent, and `app/sitemap.ts` is absent.

`tests/fee-wiring.test.ts:13–26` has two additional coverage weaknesses. First, line 16 searches for the literal `post('/api/orders'`, but the actual route is `router.post('/orders'` in `server/routes/orderRoutes.ts:226`; when the search misses, the test falls back to scanning a much broader source string rather than isolating the route. Second, lines 23–26 check `src/server/financeService.ts` and `src/server/siteSettings.ts` for legacy `financeLedger.configure()` calls. `src/server/financeService.ts:8–10` explicitly disables that legacy service in production, while actual PostgreSQL funding is implemented in `server/services/financialService.ts:562–639`. Thus, the fee-wiring test does not establish that the production database-backed quote/funding behavior matches the policy. A missing compiled `server.js` can also make the bundle checks at lines 34–38 skip rather than prove the production server is current.

**Impact:** the uploaded project cannot provide a reliable clean-checkout green build/test claim. Maintainers can be falsely reassured by checklist PASS labels whose referenced tests are missing. Source tests existing on disk are not evidence they were executed.

**Minimal safe fix:** define explicit server build, start, typecheck, unit-test, integration-test and security-test commands; compile the server artifact in the same CI job; fail if any required test file/artifact is absent; remove unsupported PASS claims until logs from the actual archive hash demonstrate the result. Make CI test a clean checkout rather than an existing developer workspace.

---

## SB-14 — HIGH — Raw PostgreSQL runtime state is shipped inside the source ZIP

**Status:** Confirmed packaging issue; sensitivity of database contents unverified.  
**Files/paths:**
- `.gitignore:1–8`
- `data/pgdata/` (45 files), including `data/pgdata/global/pg_control`, `data/pgdata/pg_wal/000000010000000000000001`, `data/pgdata/postmaster.pid`

**Evidence**

The ZIP includes a PostgreSQL data directory (~18.57 MB) with internal control and WAL files. `.gitignore` excludes `node_modules`, `build`, `dist`, coverage, logs, and `.env*`, but does not exclude `data/pgdata/`.

**Impact:** the archive is not cleanly portable and may contain records from a developer or local environment. Actual records were not decoded; this report does not claim that specific private data was extracted. If the database is real and has been distributed, it may require a security/privacy incident assessment.

**Minimal safe fix:** remove live database files from source control/release archives, add `data/pgdata/` and other runtime storage paths to `.gitignore`, reset the release archive, and use migrations plus synthetic seed data. Inspect the data in a controlled environment before concluding whether private data was disclosed.

---

## SB-15 — HIGH — Site settings report success before durable PostgreSQL persistence completes

**Status:** Confirmed statically.  
**Files:**
- `src/server/siteSettings.ts:256–266, 345–364, 446–531`
- `server/services/financialService.ts:568–582`

**Evidence**

`saveToDisk()` starts a dynamic import and calls `postgresStore.saveSiteSettings(this.settings)` without awaiting it (`src/server/siteSettings.ts:256–265`). `updateSection()` calls `saveToDisk()` then immediately returns the updated section (`:363–364`); `updateFromFlatObject()` does the same at `:529–530`. Errors are logged asynchronously, and the import failure catch at `:262` is empty. Meanwhile, the PostgreSQL escrow funding path reads the persisted `site_settings` row (`server/services/financialService.ts:568–580`) as its runtime fee source.

**Impact:** an admin API can report a fee-setting update as successful while the database row still contains the old values (or persistence has failed). The in-memory site settings/legacy ledger can therefore reflect a new rate while actual PostgreSQL funding keeps using an old rate.

**Minimal safe fix:** make settings update persistence awaited, transactional, validated, and acknowledged only after commit. If saving fails, roll back the in-memory state and return a non-2xx response. Add a round-trip test: update fee setting, read it back through the funding configuration path, then quote/fund a test order.

---

## SB-16 — HIGH (CONDITIONAL) — Proposal acceptance is locked per proposal, not per project

**Status:** Confirmed lock design; race is conditional on a single-hire project policy and needs concurrency reproduction.  
**Files:**
- `server/routes/proposalRoutes.ts:195–220, 303–310`
- `server/db/migration.sql:89` (`accepted_proposal_id` column exists)

**Evidence**

The route locks using `tryAcquireOrderLock(proposal.id, res)` at `server/routes/proposalRoutes.ts:199`, so two different proposals for the same project acquire different application-level locks. It accepts project status `open`, `published`, **or `in_progress`** (`:205–207`). After funding it updates the chosen proposal at `:303–309` and sets project status to `in_progress` without a compare-and-set predicate at `:310`. The `accepted_proposal_id` column is present in the migration (line 89) but is not written by this acceptance update.

**Impact:** if the product intends one accepted proposal per project, separate concurrent or subsequent acceptance calls can create more than one funded order for the same single-hire project and leave the accepted-proposal reference unset. If multiple freelancers per project are intended, this may be a missing explicit project hiring model rather than a defect; that policy must be made explicit.

**Minimal safe fix:** decide and encode the hiring cardinality. For single hire, acquire a DB row lock on the project, atomically change from open/published to in_progress with `WHERE status IN ('open','published')`, write `accepted_proposal_id`, and create/fund the order in a transaction. Add a two-proposal concurrent acceptance test.

---

## SB-17 — MEDIUM — WebSocket URL-token authentication can leak bearer tokens to infrastructure logs

**Status:** Confirmed design risk.  
**Files:** `server/websocket.ts:53–77`

**Evidence**

The WebSocket server accepts a `token` query parameter (`server/websocket.ts:53–63`) and explicitly logs that query-token usage may lead to leakage (`:62`). The code validates the token and active user (`:63–76`), which is a positive control, but query-string tokens can be captured by reverse-proxy access logs, diagnostics, monitoring, or URL histories.

**Impact:** an otherwise valid bearer token could persist in logs outside the intended auth subsystem, depending on deployment logging.

**Minimal safe fix:** prefer a first-message authentication handshake or secure cookie-based handshake where appropriate. If query tokens must remain temporarily, configure every proxy and telemetry layer to redact query strings and add a short token TTL/session-version check.

---

## SB-18 — MEDIUM — WorkStream file extension allowlist exists but upload endpoint does not enforce it

**Status:** Confirmed statically; exploitability depends on serving/storage configuration.  
**Files:**
- `server/services/workstreamService.ts:32–40`
- `server/routes/workstreamRoutes.ts:224–300, 324–342`

**Evidence**

`WORKSTREAM_ALLOWED_EXTENSIONS` is defined at `server/services/workstreamService.ts:32–38`, but the upload route `server/routes/workstreamRoutes.ts:224–300` does not import or check the set. It derives the extension from the user-provided filename at `:232–238`, enforces size at `:244–246`, validates order/workspace participation at `:248–270`, and stores the upload at `:272–284`. Serving includes a CSP for certain potentially active extensions at `:324–327`, and non-inline files are forced to download at `:329`, which are useful controls but not a substitute for an upload policy.

**Impact:** extensions the product team may believe are blocked can still be uploaded. That widens storage, malware, content-sniffing, and moderation risks, even though the current file-serving route has some protective headers/download behavior.

**Minimal safe fix:** enforce the allowlist server-side (or delete the unused allowlist if unrestricted uploads are intentional), validate MIME by file content rather than trusting `Content-Type`, scan where warranted, and test that disallowed extensions return 400/415.

---

## SB-19 — HIGH — Database referential integrity is largely left to application cleanup

**Status:** Confirmed schema-level observation.  
**Files:** `server/db/migration.sql:535–575` and related table definitions throughout `server/db/migration.sql`

**Evidence**

The migration’s only explicit `REFERENCES` clause found in the schema scan is `ledger_entries.journal_id REFERENCES ledger_journals(id) ON DELETE CASCADE` at `server/db/migration.sql:547`. The `escrows` table begins at `:558` and defines `order_id` as a primary key but no FK to `orders`. Related table definitions similarly lack foreign keys tying orders to participants/workspaces and payouts to wallets/users.

**Impact:** a code path that deletes an order can leave financial and business records orphaned. Application checks help, but they cannot enforce consistency if a process crashes, a new route omits a check, or two writes race. This materially worsens SB-05’s cleanup risk.

**Minimal safe fix:** add suitable FK/unique/check constraints for order, workspace, escrow, participant, proposal, payout, and ledger relationships after auditing existing dirty data. Use restrictive deletes or explicit archival/reversal semantics for financial tables; do not cascade-delete financial history casually.

---

## SB-20 — MEDIUM — Documentation and readiness checklist are materially out of sync with the archive

**Status:** Confirmed.  
**Files:**
- `README.md:5–20`
- `package.json:1–20`
- `TABLE_OF_CONTENTS.md`
- `docs/GETTING_STARTED.md:34–52, 72–86`
- `docs/SENIOR_REVIEW_CHECKLIST.md:8–39`
- Missing paths listed under SB-13

**Evidence**

`README.md` still describes a generic Google AI Studio application and asks for `GEMINI_API_KEY` (`:5–20`). `package.json` identifies the app as `react-example` version `0.0.0`. The getting-started guide states that `npm run dev` starts the full-stack server and `npm test` runs 30 automated tests (`docs/GETTING_STARTED.md:42–52`), while the package scripts and command attempts disprove that workflow for this archive. The senior checklist states PASS for test files absent from the ZIP (`docs/SENIOR_REVIEW_CHECKLIST.md:11, 13, 15`) and claims lint/test passes (`:18, 25–39`) without a reproducible test setup in this archive.

**Impact:** maintainers and reviewers can rely on a false release picture, run the wrong commands, or believe a missing component exists.

**Minimal safe fix:** replace template documentation with actual architecture and commands, generate a real file inventory, tag PASS only when backed by CI logs for the exact commit/archive hash, and mark each missing suite as NOT RUN/NOT PRESENT rather than PASS.

---

## SB-21 — MEDIUM — Production security configuration still needs systematic hardening verification

**Status:** Partly confirmed and partly unverified; not labelled as an exploit.  
**Files:**
- `server.ts:91–122`
- `server/middleware/auth.ts`
- `server/websocket.ts:53–87`
- `package.json`
- `.env.example`

**Evidence**

`server.ts:106–114` sets `X-Content-Type-Options`, `Referrer-Policy`, conditional HSTS, and request IDs. The scanned configuration does not show a global CSP/Helmet-style header policy, and the package does not list Helmet. `.env.example` has placeholders, and this static pass did not confirm a hard-coded production credential. The authentication layer has secret checks and token verification, but static review cannot establish production secret rotation, proxy trust settings, all endpoint rate-limit coverage, or deployed TLS. The code sets `app.set('trust proxy', 1)` at `server.ts:92`, which must match the actual reverse-proxy topology.

**Impact:** this is a security-hardening verification gap, not proof that the deployment is vulnerable. Misconfigured proxy trust, unredacted query tokens, or incomplete headers/rate limits could undermine otherwise useful middleware.

**Minimal safe fix:** deploy with managed secrets, confirm proxy/TLS behavior, centralize route inventory and rate-limit review, add a CSP appropriate to the application, run dependency/secret scanning in CI, and test rate limits on signup/login/verification, payout, checkout, uploads, and admin-sensitive routes.

---

## SB-22 — HIGH — A full end-to-end pass cannot currently be claimed

**Status:** Unverified due to observed build/test blockers.  
**Files:**
- `package.json`
- `tests/concurrency-race-stress.test.ts`
- `tests/ledger.safety.test.ts`
- `tests/security.test.ts`
- `tests/webhook.test.ts`
- `tests/workstream.test.ts`
- `tests/auto-accept.test.ts`
- `tests/phase3-workspace-invariants.test.ts`
- `tests/fees.test.ts`

**Evidence**

The repository contains tests for concurrency, ledger integrity, security, webhook and WorkStream behavior. However, the standard `npm test` entry point is missing and the current checkout lacks local Vite/TSX tools, so these tests were not run as an integrated suite. They must not be described as passing based solely on their presence. Live browser, WebSocket, cloud-storage, PostgreSQL concurrency, and external payment provider behavior remains untested.

**Required verification:** use a clean CI environment and run the actual database-backed integration suites with fault injection, provider sandbox callbacks, and browser flows. Save the result logs against the archive SHA above. A single “PASS” summary without test command, environment, DB state, and evidence is not sufficient.

---

# 4. Cross-layer split-brain matrix

| Domain | Key files to compare | Result | Verification status |
|---|---|---|---|
| Fees | `src/shared/fees.ts`; `src/server/siteSettings.ts`; `src/server/financeLedger.ts`; `server/services/financialService.ts`; `server/routes/orderRoutes.ts`; `server/routes/proposalRoutes.ts`; `server/routes/workstreamRoutes.ts`; `server/routes/financialRoutes.ts`; `tests/fees.test.ts` | Defaults/tests disagree with policy; multiple sources can quote differently | **Confirmed — Critical** |
| Order creation | `server/routes/orderRoutes.ts`; `server/routes/proposalRoutes.ts`; `server/services/orderService.ts`; `src/server/workspaceService.ts` | Project amount/participants not consistently derived; cleanup window can delete order after money commit | **Confirmed / conditional failure** |
| WorkStream isolation | `server/routes/orderRoutes.ts`; `server/routes/workstreamRoutes.ts`; `src/server/workspaceService.ts`; `tests/phase3-workspace-invariants.test.ts` | New orders may reuse existing workspace; test encodes different invariant from required product rule | **Confirmed mismatch** |
| Escrow/ledger | `server/services/financialService.ts`; `server/db/migration.sql`; `server/routes/financialRoutes.ts`; `server/routes/orderRoutes.ts` | DB transactions exist for individual movements, but business flow spans multiple commits; fee breakdown can diverge | **Confirmed risk** |
| Payouts | `server/services/payoutService.ts`; `server/services/financialService.ts`; `src/server/siteSettings.ts`; `src/server/financeLedger.ts` | Retry key can return prior financial result while route creates a new payout row; configured limits not enforced in DB path | **Confirmed — Critical/High** |
| Payments/webhooks | `server/routes/financialRoutes.ts`; `src/server/siteSettings.ts`; `package.json` | Checkout is an internal generated URL, not a provider-created session; webhook not matched to stored intent | **Confirmed static issue; live integration unverified** |
| Auth/security settings | `server/routes/authRoutes.ts`; `src/server/siteSettings.ts`; `server/middleware/auth.ts` | Security settings are not consistently enforceable; new signup is marked email-verified | **Confirmed mismatch** |
| Upload and file access | `server/services/workstreamService.ts`; `server/routes/workstreamRoutes.ts`; `server/jobs/backgroundJobs.ts` | Access checks exist, but extension allowlist is not enforced and aged upload records are deleted regardless of references | **Mixed: positive access controls; confirmed retention/policy gaps** |
| Proposal acceptance | `server/routes/proposalRoutes.ts`; `server/db/migration.sql` | Lock per proposal only; project-level single-hire protection absent if required by product | **Conditional** |
| SSR/public data | `server/ssr.ts:112–125`; `server/publicData.ts:27–55` | Public filters and explicit safe-field sanitization are present | **Positive source-level control; still needs regression tests** |
| Order details/messages | `server/routes/orderRoutes.ts:176–219`; `server/routes/workstreamRoutes.ts:348–359` | Participant checks visible in inspected routes | **Positive source-level control; not E2E tested** |
| Build/test | `package.json`; `scripts/verify-build.mjs`; `tests/`; `docs/GETTING_STARTED.md`; `docs/SENIOR_REVIEW_CHECKLIST.md` | No `test`/`start` scripts; build command does not compile server; checklist references missing tests | **Observed command failures** |
| Persistence settings | `src/server/siteSettings.ts`; `server/services/financialService.ts` | Settings writes return before Postgres persistence finishes; finance reads persisted values | **Confirmed mismatch window** |
| DB integrity | `server/db/migration.sql` | Minimal FK coverage makes orphan records easier | **Confirmed schema observation** |
| Archive/release | `.gitignore`; `data/pgdata/`; `README.md`; `package.json` | Raw database state packaged; starter documentation remains | **Confirmed packaging/docs issues** |

---

# 5. Positive controls observed

An advanced audit should identify controls that are working in source, not only defects:

- `server/routes/orderRoutes.ts:176–219` checks that order detail requests come from a buyer/seller participant or privileged admin.
- `server/routes/workstreamRoutes.ts:348–359` verifies WorkStream message access against order participants.
- `server/routes/workstreamRoutes.ts:251–270` verifies participant access for explicit order/workspace upload associations.
- `server/routes/workstreamRoutes.ts:304–342` uses an access check before serving upload records and applies `nosniff`, private/no-store cache headers, frame denial, and a restrictive CSP for selected active extensions.
- `server/routes/financialRoutes.ts:298–308, 683–693, 742–752, 867–888` contains owner/admin checks on inspected payment snapshot, transaction, invoice, and payment-method read paths.
- `server/routes/financialRoutes.ts:457–472` verifies a raw-body HMAC signature with a constant-time equality check. This signature check is a positive control, although SB-10 identifies the missing payment-intent reconciliation.
- `server/ssr.ts:112–125` applies public filters and sanitizers, and `server/publicData.ts:27–47` explicitly returns a safe subset of public user fields rather than the whole user record.

These controls should be preserved and covered by regression tests while fixing the findings.

---

# 6. Required regression and fault-injection matrix

Every test below should verify both the API/UI response and the persisted database + ledger state.

## 6.1 Financial policy and accounting

1. Assert 20% commission and exactly 80% freelancer net at `$5`, `$50`, `$199.99`, `$200.00`, `$200.01`, and `$5,000`.
2. Assert the 5.5% client service fee is charged on each applicable gig price; assert the $3.50 fee is applied only when gig price is `< $200`.
3. Change fee configuration, create/fund/release an order, then verify checkout quote, order `feeBreakdown`, escrow row, ledger journal, seller clearing amount, invoice, refund, and admin report all reconcile exactly.
4. Fund an order at 0% commission and release it; assert commission remains 0%.
5. Top up an order under/at/over $200 and assert fee policy is not recomputed on the wrong price basis.
6. Full refund after partial refund; repeated refund request; duplicate release request; disputes and split settlement; assert never-refunded fees and returned fees follow policy and no amount is paid twice.

## 6.2 Payout idempotency and policy enforcement

1. Submit the same payout request twice without an idempotency header; verify a single payout record, one debit, one hold, one journal and one stable ID.
2. Replay the same idempotency key with a different amount, account, or method; require conflict rather than reusing stale result.
3. After a payout is processed/cancelled, request the same amount/method again with a new operation key; verify a legitimate new payout can be created.
4. Attempt below-minimum, above-maximum, over-daily-limit, disabled method, missing KYC, account mismatch, and early-withdrawal requests; assert server-side rejection.
5. Concurrent payout requests whose combined value exceeds wallet balance or daily cap; assert only allowed requests commit.

## 6.3 Order / WorkStream isolation

1. Same buyer buys the same gig twice from the same seller: two Orders, two WorkStreams, two Escrows.
2. Same buyer accepts two separate projects from the same seller: two Orders, two WorkStreams, two Escrows.
3. Final invoice/submission for an existing order: no new Order, WorkStream or Escrow.
4. Attempt generic project order with unrelated project ID, unauthorized seller, or amount inconsistent with accepted proposal: reject.
5. After completed/cancelled order, create follow-on paid work: verify new thread for the new transaction, per the product invariant.
6. Change order/workspace IDs in message/file requests as an unrelated user; require 403/404 and no data leakage.

## 6.4 Atomicity and recovery

Inject a failure after each step: workspace create, order save, offer insert, first financial SQL write, escrow insert, ledger insert, idempotency insert, `fundOrderEscrowWithEvent` return, order status update, message insert, and notification event. For each failure, assert one of two valid outcomes only:

- fully committed and recoverable funded transaction; or
- fully rolled back/reversed transaction with no orphaned escrow, wallet movement, ledger journal, payout, offer, workspace reference, or idempotency result.

Do not accept “HTTP 400” as proof that money rolled back.

## 6.5 Auth, settings and gateway

1. Toggle each security setting and test signup/login/payout/admin behavior through actual routes.
2. Verify email is not marked verified until the verification code is accepted when required.
3. Verify disabled registration blocks signup immediately after the setting commit.
4. Sandbox-checkout success, cancellation, expiry, wrong amount/currency, duplicate webhook, invalid signature, unknown checkout ID, wrong user, and provider transaction replay.
5. Verify only the exact persisted checkout intent is credited once and a browser success redirect alone never credits a wallet.

## 6.6 WorkStream retention and delivery lifecycle

1. Reference an upload from a message/deliverable/revision on day 1 and keep the order open past day 7; verify the file remains accessible.
2. Delete a truly unreferenced upload past the retention period; verify both the DB record and cloud object are cleaned.
3. Test allowed/disallowed extensions and MIME spoofing.
4. Delivery → buyer review → revision → resubmission → approve/release; auto-accept after configured deadline; disputes must pause auto-accept; verify same order/workspace/escrow IDs throughout.

## 6.7 Build/release integrity

1. Clean install from the archive; database migration from empty PostgreSQL; build client and server; start server; health check; run all tests by documented command.
2. Require CI to fail for absent test files, absent `server.js` when required, stale artifact, untracked database files, or documented PASS rows without actual results.
3. Generate a test report that includes archive/commit SHA, command, environment, database version, number of tests discovered, passed, failed, skipped, and artifact paths.

---

# 7. Prioritized remediation plan

## P0 — Before any production money movement

1. **Fix fee policy and consolidate all fee calculation.** Files: `src/shared/fees.ts`, `src/server/siteSettings.ts`, `src/server/financeLedger.ts`, `server/services/financialService.ts`, `server/routes/orderRoutes.ts`, `server/routes/proposalRoutes.ts`, `server/routes/workstreamRoutes.ts`, `server/routes/financialRoutes.ts`, `tests/fees.test.ts`.
2. **Fix payout idempotency mapping.** Files: `server/services/payoutService.ts`, `server/services/financialService.ts`, `server/db/migration.sql`, payout tests to add.
3. **Make order + funding atomic or safely compensatable.** Files: `server/routes/orderRoutes.ts`, `server/routes/proposalRoutes.ts`, `server/routes/workstreamRoutes.ts`, `server/services/financialService.ts`, `server/db/migration.sql`.
4. **Harden non-gig/project order creation.** File: `server/routes/orderRoutes.ts`; derive amount/seller/project linkage only from an authorized proposal or explicit authorized custom-order flow.
5. **Ensure each separately paid order has its own WorkStream.** Files: `server/routes/orderRoutes.ts`, `src/server/workspaceService.ts`, `server/routes/workstreamRoutes.ts`, `tests/phase3-workspace-invariants.test.ts`.
6. **Do not delete referenced deliverables.** Files: `server/services/workstreamService.ts`, `server/jobs/backgroundJobs.ts`, `server/routes/workstreamRoutes.ts`.
7. **Do not market checkout as live until a real provider session and intent reconciliation exist.** File: `server/routes/financialRoutes.ts` plus provider integration configuration.

## P1 — Security/control integrity

8. Wire payout policy/KYC controls into PostgreSQL path: `src/server/siteSettings.ts`, `server/services/payoutService.ts`, `server/services/financialService.ts`.
9. Wire signup and security settings: `src/server/siteSettings.ts`, `server/routes/authRoutes.ts`, admin settings handlers in `server/routes/adminRoutes.ts`.
10. Await/transactionalize settings persistence: `src/server/siteSettings.ts`, `server/db/postgresStore.ts`.
11. Add foreign keys/checks and reconciliation-safe delete rules: `server/db/migration.sql`.
12. Remove query-token WebSocket auth or ensure complete redaction: `server/websocket.ts`, deployment proxy logging config.
13. Enforce upload extension/MIME policy: `server/services/workstreamService.ts`, `server/routes/workstreamRoutes.ts`.

## P2 — Release reproducibility and documentation

14. Implement server build/start/test commands: `package.json`, `scripts/verify-build.mjs`, tests and CI workflows.
15. Fix missing or outdated test/documentation references: `docs/GETTING_STARTED.md`, `docs/SENIOR_REVIEW_CHECKLIST.md`, `TABLE_OF_CONTENTS.md`, `README.md`.
16. Remove runtime database files from release: `.gitignore`, `data/pgdata/`, packaging scripts.
17. Run full browser + PostgreSQL + storage + provider-sandbox tests; save the logs tied to the archive SHA.

---

# 8. Consolidation with the earlier report

The earlier `FivePa_Split_Brain_Deep_Audit_Report.md` findings are all retained and expanded in this combined report:

| Earlier finding | Where it is covered here |
|---|---|
| F-01 fee policy/default mismatch | SB-01 |
| F-02 missing reproducible test/build workflow | SB-13, SB-22 |
| F-03 raw PostgreSQL files in ZIP | SB-14 |
| F-04 multiple fee engines/config surfaces | SB-02 |
| F-05 workspace reuse | SB-06 |
| F-06 funding then cleanup without financial reversal | SB-05 |
| F-07 runtime behavior not verified | Scope limitations, SB-22, Section 6 |
| F-08 generic starter docs/project identity drift | SB-20 |
| F-09 production security unknowns | SB-17, SB-18, SB-21 |
| F-10 misleading fee comments/admin defaults | SB-01, SB-02, SB-15 |
| F-11 user-visible end-to-end flows unverified | SB-22, Section 6 |

This report also adds deeper findings SB-03, SB-04, SB-07 through SB-12, SB-15 through SB-19 and the detailed verification/regression plan.

---

# 9. Final conclusion

This audit found multiple concrete disagreements between business policy, routes, financial services, stored order data, tests, and operational instructions. The most urgent are fee policy drift, payout idempotency, project order authorization/price derivation, non-atomic funding cleanup, WorkStream file expiry, and the failure to enforce configured payout/security controls.

**Do not interpret the existence of tests or a checklist marked PASS as proof that the application is safe.** The current archive's documented test command is absent, build/lint commands fail in the extracted environment, and the key money-moving paths have not yet been dynamically exercised. Correct the P0 findings, then run the fault-injection and full regression matrix before production release.

**Files changed by this audit:** none.  
**New artifacts produced:** this combined report and its complete archive file inventory appendix below.  
**Production tests run:** none. Only clean-archive build/test/lint command attempts were performed, and all three failed as recorded in SB-13.

---

# Appendix A — Complete extracted file inventory

The following list contains every file path found in the submitted ZIP, including PostgreSQL runtime data files. File names are included explicitly so the archive scope is auditable.

.env.example
.gitignore
README.md
TABLE_OF_CONTENTS.md
bun.lock
data/pgdata/PG_VERSION
data/pgdata/base/1/112
data/pgdata/base/1/113
data/pgdata/base/1/1247
data/pgdata/base/1/1247_fsm
data/pgdata/base/1/1247_vm
data/pgdata/base/1/1249
data/pgdata/base/1/1249_fsm
data/pgdata/base/1/1249_vm
data/pgdata/base/4/2660
data/pgdata/base/4/2663
data/pgdata/base/4/2678
data/pgdata/base/4/2679
data/pgdata/base/4/2680
data/pgdata/base/4/2681
data/pgdata/base/4/2690
data/pgdata/base/4/2693
data/pgdata/base/4/2696
data/pgdata/base/4/2701
data/pgdata/base/4/2703
data/pgdata/base/4/2831
data/pgdata/base/4/2832
data/pgdata/base/4/2835
data/pgdata/base/4/2836
data/pgdata/base/4/2837
data/pgdata/base/4/2838
data/pgdata/base/4/2839
data/pgdata/base/4/3081
data/pgdata/base/4/3118
data/pgdata/base/4/3119
data/pgdata/base/4/3164
data/pgdata/base/4/3350
data/pgdata/base/4/3429
data/pgdata/base/4/3431
data/pgdata/base/4/3433
data/pgdata/base/4/3439
data/pgdata/base/5/pg_internal.init
data/pgdata/global/pg_control
data/pgdata/global/pg_internal.init
data/pgdata/pg_logical/replorigin_checkpoint
data/pgdata/pg_multixact/offsets/0000
data/pgdata/pg_subtrans/0000
data/pgdata/pg_wal/000000010000000000000001
data/pgdata/pg_xact/0000
data/pgdata/postmaster.pid
docs/API_REFERENCE.md
docs/COMMERCIAL_ARCHITECTURE.md
docs/GETTING_STARTED.md
docs/SENIOR_REVIEW_CHECKLIST.md
index.html
logs123/runtime-diagnostics.txt
metadata.json
package-lock.json
package.json
public/assets/aistudio/image_1373a4be.png
public/assets/aistudio/image_7785046a.png
public/robots.txt
public/sitemap.xml
scripts/apply-patch.ts
scripts/generate_fresh_dataset.js
scripts/stamp-build.mjs
scripts/verify-build.mjs
server.ts
server/access.ts
server/cloudStorage.ts
server/db/migration.sql
server/db/postgresStore.ts
server/jobs/backgroundJobs.ts
server/middleware/auth.ts
server/publicData.ts
server/routes/adminRoutes.ts
server/routes/authRoutes.ts
server/routes/financialRoutes.ts
server/routes/gigRoutes.ts
server/routes/index.ts
server/routes/notificationRoutes.ts
server/routes/orderRoutes.ts
server/routes/projectRoutes.ts
server/routes/proposalRoutes.ts
server/routes/reviewRoutes.ts
server/routes/rootRoutes.ts
server/routes/userRoutes.ts
server/routes/workstreamRoutes.ts
server/services/authService.ts
server/services/diagnosticService.ts
server/services/disputeService.ts
server/services/financialService.ts
server/services/messagingService.ts
server/services/notificationService.ts
server/services/orderService.ts
server/services/payoutService.ts
server/services/reviewService.ts
server/services/workstreamService.ts
server/ssr.ts
server/store.ts
server/websocket.ts
src/App.tsx
src/components/AdminOrdersManager.tsx
src/components/FreelancerProfileView.tsx
src/components/HeaderCategoriesNav.tsx
src/components/PaymentsModule.tsx
src/components/SettingsPage.tsx
src/components/SiteFeeSettingsModule.tsx
src/components/UserWalletsLedgerModule.tsx
src/components/admin_dashboard/AdminHeader.tsx
src/components/admin_dashboard/AdminOverviewMetrics.tsx
src/components/admin_dashboard/AdminSidebarNav.tsx
src/components/admin_dashboard/index.ts
src/components/admin_modules/AdminActivityModule.tsx
src/components/admin_modules/AdminCategoriesModule.tsx
src/components/admin_modules/AdminCmsModule.tsx
src/components/admin_modules/AdminContractsModule.tsx
src/components/admin_modules/AdminDisputesModule.tsx
src/components/admin_modules/AdminEscrowModule.tsx
src/components/admin_modules/AdminGigsModule.tsx
src/components/admin_modules/AdminMembershipsQuotasModule.tsx
src/components/admin_modules/AdminMessagesModule.tsx
src/components/admin_modules/AdminOverviewModule.tsx
src/components/admin_modules/AdminPaymentGatewaysModule.tsx
src/components/admin_modules/AdminPayoutsModule.tsx
src/components/admin_modules/AdminProjectsModule.tsx
src/components/admin_modules/AdminProposalsModule.tsx
src/components/admin_modules/AdminRefundsModule.tsx
src/components/admin_modules/AdminReportsModule.tsx
src/components/admin_modules/AdminReviewsModule.tsx
src/components/admin_modules/AdminSupportModule.tsx
src/components/admin_modules/AdminUsersModule.tsx
src/components/admin_modules/index.ts
src/components/gig_reviews/Reviews.tsx
src/components/gig_reviews/index.ts
src/components/gigs/CreateGigView.tsx
src/components/gigs/DeleteGigModal.tsx
src/components/gigs/EditGigModal.tsx
src/components/gigs/GigDetailView.tsx
src/components/gigs/RelatedGigsSection.tsx
src/components/gigs/ViewingGigModal.tsx
src/components/gigs/index.ts
src/components/index.ts
src/components/marketplace/BuyerActivityView.tsx
src/components/marketplace/FreelancerSearchView.tsx
src/components/marketplace/MarketplaceGigsView.tsx
src/components/marketplace/ProjectDetailView.tsx
src/components/marketplace/ProjectSearchView.tsx
src/components/marketplace/index.ts
src/components/modals/EmailNotificationsModal.tsx
src/components/modals/ForgotPasswordModal.tsx
src/components/modals/LoginModal.tsx
src/components/modals/SignupModal.tsx
src/components/modals/SupportModal.tsx
src/components/modals/UserSwitchModal.tsx
src/components/modals/VerifyModal.tsx
src/components/modals/WishlistModal.tsx
src/components/modals/index.ts
src/components/profile/EditProfilePage.tsx
src/components/profile/EditUserProfileModal.tsx
src/components/profile/FreelancerProfileView.tsx
src/components/profile/InspectUserModal.tsx
src/components/profile/index.ts
src/components/ui/Avatar.tsx
src/components/ui/BaseModal.tsx
src/components/ui/GigImage.tsx
src/components/ui/MetricCard.tsx
src/components/ui/index.ts
src/components/user_dashboard/UserActivitySummarySidebar.tsx
src/components/user_dashboard/UserFreelanceOffersList.tsx
src/components/user_dashboard/UserFreelanceProjectsList.tsx
src/components/user_dashboard/UserStatsOverview.tsx
src/components/user_dashboard/index.ts
src/components/workstream/StartWorkstreamModal.tsx
src/components/workstream/WorkstreamActionsPanel.tsx
src/components/workstream/WorkstreamActivityStream.tsx
src/components/workstream/WorkstreamDeliverModal.tsx
src/components/workstream/WorkstreamEmptyState.tsx
src/components/workstream/WorkstreamFilesTab.tsx
src/components/workstream/WorkstreamHeader.tsx
src/components/workstream/WorkstreamList.tsx
src/components/workstream/WorkstreamMessageInput.tsx
src/components/workstream/WorkstreamReleaseModal.tsx
src/components/workstream/WorkstreamReviewModal.tsx
src/components/workstream/WorkstreamRevisionModal.tsx
src/components/workstream/WorkstreamSidebar.tsx
src/components/workstream/WorkstreamSummaryCard.tsx
src/components/workstream/WorkstreamTabs.tsx
src/components/workstream/WorkstreamVideoCallModal.tsx
src/components/workstream/WorkstreamWorkspace.tsx
src/components/workstream/activityClassifier.ts
src/components/workstream/index.ts
src/components/workstream/types.ts
src/constants.ts
src/entry-client.tsx
src/entry-server.tsx
src/hooks/admin/index.ts
src/hooks/admin/useLocalStorageFilter.ts
src/hooks/admin/usePagination.ts
src/hooks/index.ts
src/hooks/useAppData.ts
src/hooks/workstream/index.ts
src/hooks/workstream/useWorkstream.ts
src/hooks/workstream/useWorkstreamActions.ts
src/hooks/workstream/useWorkstreamDelivery.ts
src/hooks/workstream/useWorkstreamEscrow.ts
src/hooks/workstream/useWorkstreamFiles.ts
src/hooks/workstream/useWorkstreamFilters.ts
src/hooks/workstream/useWorkstreamList.ts
src/hooks/workstream/useWorkstreamMeeting.ts
src/hooks/workstream/useWorkstreamMessages.ts
src/hooks/workstream/useWorkstreamOffers.ts
src/hooks/workstream/useWorkstreamRealtime.ts
src/hooks/workstream/useWorkstreamReview.ts
src/hooks/workstream/useWorkstreamRevision.ts
src/hooks/workstream/useWorkstreamSelection.ts
src/index.css
src/layout/Footer.tsx
src/layout/Header.tsx
src/layout/HeaderCategoriesNav.tsx
src/layout/ImpersonationBanner.tsx
src/layout/index.ts
src/main.tsx
src/pages/AdminPage.tsx
src/pages/SettingsPage.tsx
src/pages/index.ts
src/server/controllers/README.md
src/server/financeLedger.ts
src/server/financeService.ts
src/server/middleware/README.md
src/server/middleware/auth.ts
src/server/paymentGateways.ts
src/server/routes/README.md
src/server/siteSettings.ts
src/server/workspaceService.ts
src/shared/fees.ts
src/shared/routes.ts
src/types.ts
src/utils/api.ts
src/utils/authToken.ts
src/utils/deviceId.ts
src/utils/fetchRetry.ts
src/utils/formatters.tsx
src/utils/index.ts
src/utils/messageTime.ts
src/utils/safeFileLink.ts
src/utils/slugify.ts
src/utils/workstreamUpload.ts
test-pglite.ts
tests/activity-stream-cards.test.ts
tests/auto-accept.test.ts
tests/concurrency-race-stress.test.ts
tests/fee-wiring.test.ts
tests/fees.test.ts
tests/gig-cancellation-clearance.test.ts
tests/ledger.safety.test.ts
tests/ledger.test.ts
tests/phase3-workspace-invariants.test.ts
tests/postgres-persistence.test.ts
tests/proposal-link-test.ts
tests/recovery-test.ts
tests/safe-file-link.test.ts
tests/security-fixes-test.ts
tests/security.test.ts
tests/signup-role.test.ts
tests/ssr.test.ts
tests/webhook.test.ts
tests/workspace-validation.test.ts
tests/workstream.test.ts
tsconfig.json
vite.config.ts


# Part II — Supplemental Advanced Pass (SB-23 to SB-33)

These are additional findings from a fresh targeted read of the same source archive after the prior 22 finding report. They are not duplicates of the earlier numbered findings. Where an issue is conditional or currently masked by another defect, that status is explicit.

## SB-23 — HIGH — Duplicate WorkStream file validators disagree, and the active validators do not enforce the ownership contract

**Files with issue:** `server/access.ts:105–108, 112–185, 187–241`; `server/services/workstreamService.ts:167–191, 228–274`; `server/routes/workstreamRoutes.ts:48–65, 380, 445, 588`.

**Observed split-brain:** `server/access.ts` documents that `validateMessageFileInfo(fileInfo, sender)` must only accept files uploaded by the sender (or staff), and that `validateStoredWorkstreamFiles(raw, submitter)` must verify the submitter is the uploader. Yet the `sender` and `submitter` parameters are not used to check `ownerId`, the target order, or the target workspace. `server/access.ts:105–108` also defines `workstreamFileReferencedBy(filename)` as a stub that always returns `[]`. The active WorkStream routes import the implementations from `server/services/workstreamService.ts`, not `server/access.ts` (`server/routes/workstreamRoutes.ts:48–65`). Those active implementations differ: `validateStoredWorkstreamFiles` passes through any string URL as an external deliverable when no local stored filename resolves (`server/services/workstreamService.ts:252–263`), whereas the duplicate helper in `server/access.ts` rejects external URLs (`server/access.ts:193–205`).

**Impact:** the same named validation operation has different policies depending on the import path; attachment and deliverable acceptance is not tied to the uploader or order/workspace context despite comments promising that guarantee. This can cause broken links and cross-workstream contamination. This finding alone does **not** prove that an outsider can download a protected file; `canAccessWorkstreamFile` still performs a separate participant/owner check.

**Minimal fix:** delete the duplicate implementation or make `server/access.ts` a thin re-export of the active service. On every accepted stored file, verify its upload record, uploader/staff permission, and that its `orderId` or `workspaceId` belongs to the exact target WorkStream. Permit external URLs only through a separate explicit safe-link policy with scheme validation. Remove `workstreamFileReferencedBy` if not used, or implement it and make cleanup use it.

**Verification:** confirmed statically; dynamic API tests not run.

## SB-24 — HIGH — Production cloud uploads conflict with validators that only check local disk

**Files with issue:** `server/cloudStorage.ts:9–31`; `server/routes/workstreamRoutes.ts:224–300`; `server/services/workstreamService.ts:21–28, 228–274`; `server/services/workstreamService.ts:277–302`; `server/jobs/backgroundJobs.ts:41–48`.

**Observed split-brain:** in production, `uploadFileToCloudStorage()` writes the file to Google Cloud Storage (`server/cloudStorage.ts:21–27`) and does not write the bytes to `WORKSTREAM_UPLOADS_DIR`. The upload route then returns a local-looking URL and saves an upload record (`server/routes/workstreamRoutes.ts:273–295`). But the active `validateMessageFileInfo` rejects the file unless `workstreamFileExists(filename)` finds it on local disk (`server/services/workstreamService.ts:232–235`), and `validateStoredWorkstreamFiles` likewise checks local disk (`:265–267`). Therefore a successful production cloud upload can be rejected when subsequently attached to a message or invoice/deliverable, unless another process happens to create a local copy.

The cleanup job also deletes only a local path and the database record (`server/services/workstreamService.ts:277–302`); it does not call the available `deleteFileFromCloudStorage()` in `server/cloudStorage.ts:34–49`. In production, this can orphan cloud objects after their metadata is removed. The cleanup runs hourly (`server/jobs/backgroundJobs.ts:41–48`) and its seven-day TTL can also remove metadata for files that are still referenced by orders/messages/deliveries (see SB-07).

**Impact:** production message/deliverable attachments may fail even though the upload endpoint reported success; file metadata and cloud-object lifecycle can diverge; cloud storage objects may remain after records are deleted.

**Minimal fix:** introduce one storage abstraction whose `exists`, `size`, `read`, and `delete` operations support local and GCS backends. Do not use `fs.existsSync` as the authoritative existence check in production. Persist an explicit backend/object key. Before cleanup, prove the file is unreferenced and past retention; then delete both object and metadata transactionally/idempotently.

**Verification:** confirmed statically; cloud integration not run.

## SB-25 — CRITICAL — The normal gig-order path rejects every gig due to a camelCase/snake_case property mismatch

**Files with issue:** `server/services/orderService.ts:125–156`; `server/routes/orderRoutes.ts:260–265`; `tests/fee-wiring.test.ts:13–20` (the current source-level guard does not catch this property mismatch).

**Observed split-brain:** `resolveGigOrderPrice()` returns a normalized `gig` object whose owner property is named `freelancerId` (`server/services/orderService.ts:146–153`). The route destructures that normalized object into `gigRow` and then checks `gigRow.freelancer_id !== sellerId` (`server/routes/orderRoutes.ts:261–263`). The returned object has no `freelancer_id` property, so the expression evaluates as `undefined !== sellerId` for a normal request and the route returns HTTP 400 (“This gig does not belong to the selected seller.”) before creating/funding the order.

**Impact:** the normal paid gig purchase route appears unable to complete any regular gig checkout. The frontend can show published gigs, but this property-name mismatch blocks the server-side purchase path.

**Minimal fix:** use the normalized property `gigRow.freelancerId`, or return a consistently typed shape from `resolveGigOrderPrice()`. Replace `any` with a `ResolvedGigOrder` type and add a route-level test that purchases a gig owned by the selected seller and rejects a gig owned by a different seller.

**Verification:** deterministic source-level defect; live endpoint reproduction not run because the backend/test environment could not be started.

## SB-26 — HIGH / LATENT — Gig purchase does not enforce publication or moderation state (currently masked by SB-25)

**Files with issue:** `server/routes/orderRoutes.ts:260–265`; `server/services/orderService.ts:125–156`; `server/publicData.ts:49–51`; `server/routes/gigRoutes.ts:56–94`.

**Observed split-brain:** public listing/detail code requires a published gig with approved (or absent) moderation status (`server/publicData.ts:49–51`; `server/routes/gigRoutes.ts:57–62, 70–94`). The order route resolves a gig by ID and checks only the seller relationship (`server/routes/orderRoutes.ts:260–265`); `resolveGigOrderPrice()` queries by ID without checking `status` or moderation (`server/services/orderService.ts:125–156`).

**Important qualification:** in the current source, SB-25’s property mismatch rejects the purchase before funding, so a hidden-gig purchase is not shown as currently exploitable through this path. Once SB-25 is fixed, the missing publication/moderation guard becomes reachable unless fixed at the same time.

**Minimal fix:** have the same server-side resolver assert `status === 'published'` and `moderation_status` is approved before returning a purchasable gig; permit unpublished gigs only for a separate explicit owner/admin preview route that can never fund an order.

**Verification:** confirmed missing guard statically; exploitability is conditional on fixing SB-25 or another route bypassing the same check.

## SB-27 — MEDIUM — WorkStream “turnaround days” selected in the UI is ignored for a custom order

**Files with issue:** `src/components/workstream/StartWorkstreamModal.tsx:26–46, 132–133`; `src/hooks/workstream/useWorkstreamActions.ts:26–45`; `server/routes/orderRoutes.ts:270–284`.

**Observed split-brain:** the modal collects `turnaroundDays` and defaults to five (`StartWorkstreamModal.tsx:29, 40–45`). The submit handler calculates a `dueDate` based on the selected days but sends only title, sellerId, amount, dueDate and requirements; it does not send the `turnaroundDays` value (`useWorkstreamActions.ts:33–44`). The backend then ignores request `dueDate`, defaults `deliveryDays` to ten for orders without a gig/project, and derives a new server due date (`orderRoutes.ts:270–284`).

**Impact:** the UI can promise one deadline while the created order stores another; custom orders generally receive ten days regardless of the user’s selected turnaround.

**Minimal fix:** send a numeric `turnaroundDays`, validate and clamp it on the server, and derive the date server-side. Do not trust a browser-supplied absolute due date as the authoritative contract deadline. Test 1-, 5-, 10- and max-day selections and verify the persisted `dueDate`.

**Verification:** confirmed statically.

## SB-28 — MEDIUM — Escrow protection duration is live for proposal orders but factory-defaulted for generic/gig orders

**Files with issue:** `src/server/siteSettings.ts:145–153, 465–467`; `server/routes/orderRoutes.ts:352–357`; `server/routes/proposalRoutes.ts:222–245`; `server/routes/workstreamRoutes.ts:809–814`.

**Observed split-brain:** settings accepts `escrowHoldDays` and maps it to `commission.escrowProtectionDays` (`siteSettings.ts:465–467`). Proposal acceptance uses `siteSettings.getSettings().commission.escrowProtectionDays` (`proposalRoutes.ts:224–242`), as does WorkStream offer acceptance (`workstreamRoutes.ts:809–814`). The generic/gig order route instead calculates `escrowProtectionEndDate` from `DEFAULT_SITE_SETTINGS.commission.escrowProtectionDays` (`orderRoutes.ts:354`), so it ignores the current configured value.

**Impact:** two orders created on the same day can receive different protection end dates depending on whether they came through a gig checkout or proposal acceptance, even when the admin has set one intended policy.

**Minimal fix:** use a validated settings snapshot from one source for every new order path and persist the effective protection duration/policy version in the order at creation.

**Verification:** confirmed statically.

## SB-29 — MEDIUM — Admin fee simulator does not use the shared fee-rule conditions

**Files with issue:** `src/components/SiteFeeSettingsModule.tsx:199–208, 708–725`; `src/shared/fees.ts:63–90`; `src/server/siteSettings.ts:276–300`.

**Observed split-brain:** the site-fee simulator always calculates a client service surcharge as `gross × clientServiceFee / 100` (`SiteFeeSettingsModule.tsx:199–205`) and always displays that service-fee line (`:713–715`). The shared calculation instead returns zero service fee whenever the order is at or above `smallOrderThreshold` (`src/shared/fees.ts:70–78`). For a $250 example order, the simulator shows the percentage fee while the active shared helper reports zero service fee under the current rule. The business policy itself also needs SB-01 corrected; the simulator should match the final approved policy, not independently choose a third rule.

**Impact:** admins can approve a settings configuration based on a preview that does not match the quote/funding engine.

**Minimal fix:** build the simulator from the canonical fee calculator and display the returned `serviceFee`, `smallOrderFee`, `clientTotal`, commission and net rather than duplicating formulas in the component.

**Verification:** confirmed statically.

## SB-30 — HIGH — Restricted buyer can accept certain WorkStream offers that create a new funded order

**Files with issue:** `server/routes/orderRoutes.ts:226–230`; `server/routes/workstreamRoutes.ts:678–690, 742–750, 809–816, 932–983`; `server/middleware/auth.ts:228–239`.

**Observed split-brain:** the direct new-order endpoint explicitly blocks a `restricted` buyer (`orderRoutes.ts:226–230`) and shared middleware defines restricted accounts as forbidden for `requireActiveStatus` actions (`auth.ts:228–239`). The WorkStream offer endpoint uses only `requireAuth` and then explicitly allows both `active` and `restricted` users (`workstreamRoutes.ts:678–690`). Buyer acceptance logic can create a distinct follow-on order and fund escrow for a proposal offer in the completed/cancelled project or follow-on branch (`workstreamRoutes.ts:742–750, 809–816, 932–983`) without a restricted-status purchase block.

**Impact:** the restriction is enforced in one purchase path but bypassed in a WorkStream offer-acceptance path. This finding concerns the branch that creates a new order; ordinary decisions about an existing invoice/contract may need a different policy.

**Minimal fix:** centralize a server-side `canCreateFundedOrder(user, context)` decision and enforce it on every route that creates/funds a new order, including proposal acceptance and WorkStream follow-on acceptance. Separate allowed actions on existing orders from permission to start a new paid transaction.

**Verification:** control-flow gap confirmed statically; live API test not run.

## SB-31 — HIGH — Missing production gateway-encryption key falls back to saving the secret in plaintext

**Files with issue:** `src/server/paymentGateways.ts:45–69, 121–148, 168–199`; `server/routes/adminRoutes.ts:493–520`; `server/db/postgresStore.ts` (payment-gateway persistence path).

**Observed split-brain:** `getEncryptionKey()` correctly throws in production when `GATEWAY_ENCRYPTION_KEY` is absent (`paymentGateways.ts:45–53`). But `encryptSecret()` catches that error and returns the original plaintext value (`:56–69`). `PaymentGatewayManager.saveToDisk()` then persists the state returned by `getEncryptedState()` (`:121–148`), and the admin update route reports success if `updateGateway()` returns (`adminRoutes.ts:493–520`). Thus the intended fatal production configuration check is neutralized for this pathway: missing key may result in unencrypted `clientSecret` data being saved rather than rejecting the update.

**Impact:** payment-provider secrets may be stored in plaintext in the PostgreSQL settings payload when the required encryption key is missing or encryption throws.

**Minimal fix:** never return plaintext from the encryption failure path. Fail closed by throwing, reject the admin update, and do not persist. Add a test with `NODE_ENV=production` and no `GATEWAY_ENCRYPTION_KEY` asserting the secret is not saved. Prefer an authenticated encryption mode such as AES-GCM with versioned ciphertext; retain plaintext migration only behind an explicit migration routine, not normal persistence.

**Verification:** confirmed statically; stored production values were not inspected.

## SB-32 — HIGH — Advertised `npm run dev` starts Vite only; it neither starts Express nor proxies `/api`

**Files with issue:** `package.json:5–12`; `vite.config.ts` (server config); `server.ts:91–122, 241–255`; `README.md` Run Locally section; `docs/GETTING_STARTED.md:34–52`.

**Observed split-brain:** `package.json` defines `dev` as `vite --port=3000 --host=0.0.0.0`; it does not launch `server.ts` or `tsx`/`concurrently`. `vite.config.ts` has no `/api` proxy. The Express backend is only created/listened to by `server.ts` (`server.ts:91` and `:241–255`). Yet the README says `npm run dev` runs the app and `docs/GETTING_STARTED.md:42–46` says it starts the full-stack server on port 3000. When using the documented command from a clean checkout, the Vite SPA is started but the Express API/WebSocket backend is not started by that command, and API requests have no configured development proxy.

**Impact:** documented local testing can render the client while core API functions fail or return Vite fallback responses. A developer could misdiagnose app logic because the backend is not running.

**Minimal fix:** define separate explicit scripts such as `dev:web` and `dev:server`, or use a documented runner to start both, set distinct ports, and configure a Vite `/api` and WebSocket proxy. Ensure a single `npm run dev` command exactly matches documented behavior.

**Verification:** confirmed from scripts/config; command execution was not possible with dependencies absent, but the missing backend/proxy is visible statically.

## SB-33 — MEDIUM — `tests/fee-wiring.test.ts` can pass without scoping its check to the target route or verifying a compiled server bundle exists

**Files with issue:** `tests/fee-wiring.test.ts:13–29`; `server/routes/orderRoutes.ts:225–265`; `package.json:5–12`; `scripts/verify-build.mjs:4–20`.

**Observed split-brain:** the test searches the source for `post('/api/orders'` (`fee-wiring.test.ts:15`), while the actual router declares `router.post('/orders'` and is mounted elsewhere. When not found, the test deliberately sets `ordersRoute` to the beginning of the entire combined source string (`:16–17`), so the assertions can pass because `resolveGigOrderPrice()` and `fundOrderEscrowWithEvent()` occur somewhere in the file, not necessarily inside the route under test. The compiled-bundle check is wrapped in `if (existsSync('../server.js'))` (`:25–29`); if the compiled server artifact is missing, those assertions are silently skipped. This matters because `package.json` has no `test` script and `build` is only `vite build`, while `scripts/verify-build.mjs` expects `server.js` (`:4–20`).

**Impact:** the test may produce false confidence on the exact money path and fail to detect the SB-25 field-name defect or missing compiled server artifact.

**Minimal fix:** parse/target the actual Express router and route mount explicitly; assert `server.js` exists before bundle checks; assert expected property contracts such as `freelancerId`; run the tests in CI as mandatory steps rather than relying on comments.

**Verification:** confirmed statically; the test itself could not run because dependencies are absent and no `npm test` script exists.

---

# Part III — Consolidated source-file issue matrix

This table is the authoritative list of files with one or more explicitly assigned source-level findings. The same file can participate in several independent findings. Files not listed here are not certified clean; they simply had no direct issue assigned in this targeted pass.

| File path | Finding IDs | What disagrees / why it is marked |
|---|---|---|
| `src/shared/fees.ts` | SB-01, SB-02, SB-11, SB-12, SB-29 | Default fees/policy; central fee conditional differs from UI simulator; zero-default and top-up issues. |
| `src/server/siteSettings.ts` | SB-01, SB-02, SB-08, SB-09, SB-15, SB-28, SB-29 | Comment/value drift, persisted settings not awaited, security settings not wired, runtime defaults differ by order path. |
| `src/server/financeLedger.ts` | SB-02, SB-08, SB-12 | Legacy in-memory fee/withdrawal path differs from PostgreSQL path. |
| `server/services/financialService.ts` | SB-02, SB-03, SB-04, SB-05, SB-08, SB-11, SB-12, SB-15 | PostgreSQL financial truth, idempotency, funding/refund/top-up, and settings behavior. |
| `server/services/payoutService.ts` | SB-04, SB-08 | Payout replay may create a second row; configured limits/methods not consistently enforced. |
| `server/routes/orderRoutes.ts` | SB-01, SB-02, SB-03, SB-05, SB-06, SB-25, SB-26, SB-27, SB-28, SB-30 | Fee snapshot, project validation, rollback, workspace reuse, gig field mismatch, missing publication guard, due date and protection settings, restrictions. |
| `server/routes/proposalRoutes.ts` | SB-02, SB-03, SB-05, SB-16, SB-28 | Legacy fee quote, ownership/acceptance checks, rollback and concurrent proposal acceptance. |
| `server/routes/workstreamRoutes.ts` | SB-02, SB-05, SB-06, SB-07, SB-12, SB-18, SB-23, SB-24, SB-28, SB-30 | Fee drift, cleanup, workspace isolation, top-up/re-funding, upload checks, live policy/permission mismatch. |
| `src/server/workspaceService.ts` | SB-05, SB-06 | Workspace/order relation may reuse a workspace across multiple orders; cleanup relation implications. |
| `server/services/orderService.ts` | SB-03, SB-16, SB-25, SB-26 | Server-side gig resolver shape, project/proposal order linkage, process-local lock. |
| `server/services/workstreamService.ts` | SB-07, SB-18, SB-23, SB-24 | TTL cleanup, unused extension allowlist, ignored uploader/submitter, local-vs-cloud existence mismatch. |
| `server/access.ts` | SB-07, SB-23 | Reference helper returns empty array; duplicate validator disagrees with active service. |
| `server/cloudStorage.ts` | SB-07, SB-24 | Uploads cloud-only objects; cleanup does not invoke cloud delete; local-only validators conflict with GCS. |
| `server/jobs/backgroundJobs.ts` | SB-07, SB-24 | Hourly cleanup starts without awaiting its promise; cleanup policy deletes records without reference/cloud-object lifecycle checks. |
| `server/db/migration.sql` | SB-04, SB-05, SB-16, SB-19 | Missing critical foreign-key/unique relationship constraints; escrow-to-order orphaning and acceptance consistency. |
| `server/db/postgresStore.ts` | SB-04, SB-05, SB-07, SB-15, SB-19, SB-31 | Persistence/cleanup and referential integrity; settings/gateway persistence paths. |
| `server/routes/financialRoutes.ts` | SB-01, SB-02, SB-10, SB-12 | Fee fallbacks, simulated checkout, webhook not bound to a saved checkout intent, top-up/report drift. |
| `src/components/SiteFeeSettingsModule.tsx` | SB-01, SB-02, SB-29 | Admin simulator duplicates fee math and can preview a different total from the shared engine. |
| `src/components/gigs/GigDetailView.tsx` | SB-01, SB-02, SB-25 | UI displays quote/fallback policy that may disagree with fee defaults; affected by core gig checkout defect. |
| `src/components/marketplace/ProjectDetailView.tsx` | SB-02 | Proposal UI consumes shared defaults/quote values; fee display must match immutable order finance data. |
| `src/hooks/workstream/useWorkstreamActions.ts` | SB-27 | Calculates due date from selection but does not send `turnaroundDays`; server replaces it. |
| `src/components/workstream/StartWorkstreamModal.tsx` | SB-27 | Captures a selected deadline that is not honored downstream. |
| `server/publicData.ts` | SB-26 | Public gig visibility policy is stricter than the order resolver’s state validation. |
| `server/routes/gigRoutes.ts` | SB-26 | Catalogue/detail guards enforce published/moderated visibility, but order path omits the same checks. |
| `server/routes/authRoutes.ts` | SB-09 | Signup marks email verified immediately, hardcodes password length, and does not honor registration/security settings. |
| `server/services/authService.ts` | SB-09 | Auth and settings expectations not aligned; related verification/login behavior needs a single policy. |
| `server/routes/adminRoutes.ts` | SB-08, SB-09, SB-15, SB-31 | Admin reports settings success before persistence resolves; security/payout/gateway controls mismatch. |
| `server/middleware/auth.ts` | SB-21, SB-30 | Production auth hardening and shared restricted-state policy; order offer route bypasses shared active-status middleware. |
| `server/websocket.ts` | SB-17, SB-21 | Token in query string can leak to logging/proxy traces; deployment security needs review. |
| `server.ts` | SB-13, SB-21, SB-32 | Backend entry point is not launched by advertised dev script; build artifact expectations/security headers. |
| `src/server/paymentGateways.ts` | SB-10, SB-15, SB-31 | Live API handshake absent, async persistence, encryption error returns plaintext. |
| `package.json` | SB-13, SB-20, SB-22, SB-32, SB-33 | No `test`/`start` script; `dev` only starts Vite; build doesn't produce expected server bundle. |
| `vite.config.ts` | SB-32 | No API/WebSocket proxy and no backend runner in dev config. |
| `tests/fees.test.ts` | SB-01, SB-13 | Test heading states intended fee policy while assertions validate the incorrect default policy. |
| `tests/fee-wiring.test.ts` | SB-13, SB-25, SB-33 | Route-scope check is mis-targeted and compiled bundle assertions silently skip if `server.js` is absent. |
| `tests/security.test.ts` | SB-13 | Imports `../server.js`, which is not shipped/produced by current declared `build` script. |
| `tests/phase3-workspace-invariants.test.ts` | SB-06 | Test expectations permit workspace reuse across several orders, contrary to stated per-transaction isolation invariant. |
| `tests/concurrency-race-stress.test.ts` | SB-16, SB-22 | Race test is present but cannot be treated as passing without a runnable test pipeline/database. |
| `tests/webhook.test.ts` | SB-10, SB-22 | Presence of a webhook test does not prove gateway integration or order-intent binding; not executed. |
| `tests/workstream.test.ts` | SB-07, SB-18, SB-22 | Relevant upload/WorkStream regression suite exists but was not run; extension/retention assumptions need tests. |
| `scripts/verify-build.mjs` | SB-13, SB-20, SB-33 | Expects a compiled `server.js` that the declared build command does not generate. |
| `README.md` | SB-20, SB-32 | Generic AI Studio starter instructions do not describe the actual backend/runtime. |
| `docs/GETTING_STARTED.md` | SB-13, SB-20, SB-32 | Claims dev starts full stack and tests exist/runs although package scripts do not. |
| `docs/SENIOR_REVIEW_CHECKLIST.md` | SB-13, SB-20, SB-22 | Reports PASS for missing tests and unexecuted build/test steps. |
| `TABLE_OF_CONTENTS.md` | SB-20 | Lists files/components not present in the uploaded archive. |
| `.gitignore` | SB-14 | Does not ignore `data/pgdata/` runtime database files. |
| `.env.example` | SB-21, SB-31 | Does not establish safe gateway encryption-key operational requirements. |
| `data/pgdata/**` | SB-14 | PostgreSQL runtime data is bundled in the source archive; actual contained records were not decoded. |

---

# Part IV — Severity and verification summary

| Severity | Findings | Release posture |
|---|---|---|
| **Critical** | SB-01, SB-02, SB-04, SB-05, SB-13, SB-25 | Block release until corrected and regression-tested. |
| **High** | SB-03, SB-06, SB-07, SB-08, SB-09, SB-10, SB-12, SB-14, SB-15, SB-16, SB-19, SB-22, SB-23, SB-24, SB-26 (latent), SB-30, SB-31, SB-32 | Fix before production; some require runtime verification to establish full impact. |
| **Medium / conditional** | SB-11, SB-17, SB-18, SB-20, SB-21, SB-27, SB-28, SB-29, SB-33 | Fix or explicitly accept risk with evidence; do not call these passed without tests. |

**Verification limitation:** no current backend, PostgreSQL instance, cloud-storage bucket, payment provider, or browser test environment was successfully started. The latest source archive was statically inspected; `npm test -- --run` failed because no `test` script exists, `npm run build` failed because `vite` is not installed in the extracted checkout, and `npm run lint` failed because `vite/client` types were unavailable in that same dependency-free extraction. This does not prove that `npm ci` would fail, but it does mean no build, tests, or end-to-end pass is being claimed.

# Part V — Complete archive file inventory and issue flags

Each file in the latest archive is listed below. If a file is marked with finding IDs, it is directly implicated by source evidence in this report. “No direct finding assigned” means only that this targeted audit did not assign a specific issue to that file; it is **not** a claim that the file is clean or that every line was dynamically verified.



| File path | Split-brain status | Finding IDs / note |
|---|---|---|
| `.env.example` | **ISSUE IDENTIFIED** | SB-21, SB-31 — Gateway key operations are not documented as required |
| `.gitignore` | **ISSUE IDENTIFIED** | SB-14 — Does not exclude PostgreSQL runtime directory |
| `README.md` | **ISSUE IDENTIFIED** | SB-20, SB-32 — Generic AI Studio onboarding contradicts actual backend app |
| `TABLE_OF_CONTENTS.md` | **ISSUE IDENTIFIED** | SB-20 — Inventory references files/components absent from archive |
| `bun.lock` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `data/pgdata/PG_VERSION` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/112` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/113` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1247` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1247_fsm` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1247_vm` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249_fsm` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/1/1249_vm` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2660` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2663` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2678` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2679` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2680` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2681` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2690` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2693` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2696` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2701` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2703` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2831` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2832` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2835` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2836` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2837` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2838` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/2839` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3081` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3118` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3119` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3164` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3350` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3429` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3431` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3433` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/4/3439` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/base/5/pg_internal.init` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/global/pg_control` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/global/pg_internal.init` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_logical/replorigin_checkpoint` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_multixact/offsets/0000` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_subtrans/0000` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_wal/000000010000000000000001` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/pg_xact/0000` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `data/pgdata/postmaster.pid` | **ISSUE IDENTIFIED** | SB-14 — Runtime PostgreSQL data file packaged in source ZIP |
| `docs/API_REFERENCE.md` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `docs/COMMERCIAL_ARCHITECTURE.md` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `docs/GETTING_STARTED.md` | **ISSUE IDENTIFIED** | SB-13, SB-20, SB-32 — Claims full-stack npm dev and npm test not implemented as documented |
| `docs/SENIOR_REVIEW_CHECKLIST.md` | **ISSUE IDENTIFIED** | SB-13, SB-20, SB-22 — PASS claims reference missing/unrun tests |
| `index.html` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `logs123/runtime-diagnostics.txt` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `metadata.json` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `package-lock.json` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `package.json` | **ISSUE IDENTIFIED** | SB-13, SB-20, SB-22, SB-32, SB-33 — No test/start scripts, Vite-only dev, build artifact mismatch |
| `public/assets/aistudio/image_1373a4be.png` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `public/assets/aistudio/image_7785046a.png` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `public/robots.txt` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `public/sitemap.xml` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `scripts/apply-patch.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `scripts/generate_fresh_dataset.js` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `scripts/stamp-build.mjs` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `scripts/verify-build.mjs` | **ISSUE IDENTIFIED** | SB-13, SB-20, SB-33 — Expects server.js not emitted by declared build; build guard only tests artifact freshness |
| `server.ts` | **ISSUE IDENTIFIED** | SB-13, SB-21, SB-32 — Backend entrypoint/build/dev workflow/security headers |
| `server/access.ts` | **ISSUE IDENTIFIED** | SB-07, SB-23 — Reference helper stub and duplicate conflicting file-validation policy |
| `server/cloudStorage.ts` | **ISSUE IDENTIFIED** | SB-07, SB-24 — Cloud-only uploads and cleanup deletion mismatch |
| `server/db/migration.sql` | **ISSUE IDENTIFIED** | SB-04, SB-05, SB-16, SB-19 — Missing relationships/integrity constraints and race protections |
| `server/db/postgresStore.ts` | **ISSUE IDENTIFIED** | SB-04, SB-05, SB-07, SB-15, SB-19, SB-31 — Persistence and reference cleanup concerns; payout and settings storage paths |
| `server/jobs/backgroundJobs.ts` | **ISSUE IDENTIFIED** | SB-07, SB-24 — Hourly cleanup invokes retention logic without reference/cloud-object proof |
| `server/middleware/auth.ts` | **ISSUE IDENTIFIED** | SB-21, SB-30 — Shared status policy not applied to every new funded order path |
| `server/publicData.ts` | **ISSUE IDENTIFIED** | SB-26 — Public gig eligibility policy stronger than order resolver gate |
| `server/routes/adminRoutes.ts` | **ISSUE IDENTIFIED** | SB-08, SB-09, SB-15, SB-31 — Admin settings persistence and policy/gateway enforcement |
| `server/routes/authRoutes.ts` | **ISSUE IDENTIFIED** | SB-09 — Email verification and password/registration settings mismatch |
| `server/routes/financialRoutes.ts` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-10, SB-12 — Fee fallbacks, mock checkout/webhook binding, top-up/report drift |
| `server/routes/gigRoutes.ts` | **ISSUE IDENTIFIED** | SB-26 — Listing/detail gates not mirrored in order route |
| `server/routes/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/notificationRoutes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/orderRoutes.ts` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-03, SB-05, SB-06, SB-25, SB-26, SB-27, SB-28, SB-30 — Financial/path mismatch, project validation, rollback, workspace reuse, purchase bug/gates/deadline/policy |
| `server/routes/projectRoutes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/proposalRoutes.ts` | **ISSUE IDENTIFIED** | SB-02, SB-03, SB-05, SB-16, SB-28 — Legacy fee values, project binding/funding rollback/race, escrow duration |
| `server/routes/reviewRoutes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/rootRoutes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/userRoutes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/routes/workstreamRoutes.ts` | **ISSUE IDENTIFIED** | SB-02, SB-05, SB-06, SB-07, SB-12, SB-18, SB-23, SB-24, SB-28, SB-30 — Financial, workspace, upload/cleanup/validator and restriction consistency |
| `server/services/authService.ts` | **ISSUE IDENTIFIED** | SB-09 — Security/verification policy wiring needs consistency |
| `server/services/diagnosticService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/services/disputeService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/services/financialService.ts` | **ISSUE IDENTIFIED** | SB-02, SB-03, SB-04, SB-05, SB-08, SB-11, SB-12, SB-15 — Source-of-truth, payout idempotency, rollback, settings and top-up consistency |
| `server/services/messagingService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/services/notificationService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/services/orderService.ts` | **ISSUE IDENTIFIED** | SB-03, SB-16, SB-25, SB-26 — Gig resolver field shape and route lock/project linkage issues |
| `server/services/payoutService.ts` | **ISSUE IDENTIFIED** | SB-04, SB-08 — Payout replay duplication and policy limit enforcement |
| `server/services/reviewService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/services/workstreamService.ts` | **ISSUE IDENTIFIED** | SB-07, SB-18, SB-23, SB-24 — Unreferenced cleanup, unused extension allowlist, validator drift, local/cloud mismatch |
| `server/ssr.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/store.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `server/websocket.ts` | **ISSUE IDENTIFIED** | SB-17, SB-21 — Query-token logging and deployment hardening |
| `src/App.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/AdminOrdersManager.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/FreelancerProfileView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/HeaderCategoriesNav.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/PaymentsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/SettingsPage.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/SiteFeeSettingsModule.tsx` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-29 — Admin simulator implements fee math separately |
| `src/components/UserWalletsLedgerModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_dashboard/AdminHeader.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_dashboard/AdminOverviewMetrics.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_dashboard/AdminSidebarNav.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_dashboard/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminActivityModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminCategoriesModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminCmsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminContractsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminDisputesModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminEscrowModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminGigsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminMembershipsQuotasModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminMessagesModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminOverviewModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminPaymentGatewaysModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminPayoutsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminProjectsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminProposalsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminRefundsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminReportsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminReviewsModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminSupportModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/AdminUsersModule.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/admin_modules/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gig_reviews/Reviews.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gig_reviews/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/CreateGigView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/DeleteGigModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/EditGigModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/GigDetailView.tsx` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-25 — Fee quote/fallback and core gig purchase path impacted |
| `src/components/gigs/RelatedGigsSection.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/ViewingGigModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/gigs/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/marketplace/BuyerActivityView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/marketplace/FreelancerSearchView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/marketplace/MarketplaceGigsView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/marketplace/ProjectDetailView.tsx` | **ISSUE IDENTIFIED** | SB-02 — Proposal UI relies on default fee engine, must reconcile to transaction snapshot |
| `src/components/marketplace/ProjectSearchView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/marketplace/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/EmailNotificationsModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/ForgotPasswordModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/LoginModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/SignupModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/SupportModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/UserSwitchModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/VerifyModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/WishlistModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/modals/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/profile/EditProfilePage.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/profile/EditUserProfileModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/profile/FreelancerProfileView.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/profile/InspectUserModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/profile/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/ui/Avatar.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/ui/BaseModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/ui/GigImage.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/ui/MetricCard.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/ui/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/user_dashboard/UserActivitySummarySidebar.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/user_dashboard/UserFreelanceOffersList.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/user_dashboard/UserFreelanceProjectsList.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/user_dashboard/UserStatsOverview.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/user_dashboard/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/StartWorkstreamModal.tsx` | **ISSUE IDENTIFIED** | SB-27 — Deadline selection not honored by backend |
| `src/components/workstream/WorkstreamActionsPanel.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamActivityStream.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamDeliverModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamEmptyState.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamFilesTab.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamHeader.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamList.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamMessageInput.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamReleaseModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamReviewModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamRevisionModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamSidebar.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamSummaryCard.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamTabs.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamVideoCallModal.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/WorkstreamWorkspace.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/activityClassifier.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/components/workstream/types.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/constants.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/entry-client.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/entry-server.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/admin/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/admin/useLocalStorageFilter.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/admin/usePagination.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/useAppData.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstream.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamActions.ts` | **ISSUE IDENTIFIED** | SB-27 — UI calculates but fails to send selected turnaround days |
| `src/hooks/workstream/useWorkstreamDelivery.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamEscrow.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamFiles.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamFilters.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamList.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamMeeting.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamMessages.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamOffers.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamRealtime.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamReview.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamRevision.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/hooks/workstream/useWorkstreamSelection.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/index.css` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/layout/Footer.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/layout/Header.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/layout/HeaderCategoriesNav.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/layout/ImpersonationBanner.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/layout/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/main.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/pages/AdminPage.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/pages/SettingsPage.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/pages/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/controllers/README.md` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/financeLedger.ts` | **ISSUE IDENTIFIED** | SB-02, SB-08, SB-12 — Legacy finance engine diverges from production PostgreSQL paths |
| `src/server/financeService.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/middleware/README.md` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/middleware/auth.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/paymentGateways.ts` | **ISSUE IDENTIFIED** | SB-10, SB-15, SB-31 — No live handshake, asynchronous persistence, plaintext error fallback |
| `src/server/routes/README.md` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/server/siteSettings.ts` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-08, SB-09, SB-15, SB-28, SB-29 — Defaults/comments, setting wiring/persistence, payout and security settings, duration drift |
| `src/server/workspaceService.ts` | **ISSUE IDENTIFIED** | SB-05, SB-06 — Workspace association/reuse and cleanup |
| `src/shared/fees.ts` | **ISSUE IDENTIFIED** | SB-01, SB-02, SB-11, SB-12, SB-29 — Fee defaults/condition, multi-source math, zero fallback/top-up rules, simulator drift |
| `src/shared/routes.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/types.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/api.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/authToken.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/deviceId.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/fetchRetry.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/formatters.tsx` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/index.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/messageTime.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/safeFileLink.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/slugify.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `src/utils/workstreamUpload.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `test-pglite.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/activity-stream-cards.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/auto-accept.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/concurrency-race-stress.test.ts` | **ISSUE IDENTIFIED** | SB-16, SB-22 — Race suite exists but was not run/verified |
| `tests/fee-wiring.test.ts` | **ISSUE IDENTIFIED** | SB-13, SB-25, SB-33 — Route scan can false-pass and does not require server bundle |
| `tests/fees.test.ts` | **ISSUE IDENTIFIED** | SB-01, SB-13 — Test assertions validate wrong fee policy despite title |
| `tests/gig-cancellation-clearance.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/ledger.safety.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/ledger.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/phase3-workspace-invariants.test.ts` | **ISSUE IDENTIFIED** | SB-06 — Workspace reuse invariant conflicts with per-transaction isolation requirement |
| `tests/postgres-persistence.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/proposal-link-test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/recovery-test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/safe-file-link.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/security-fixes-test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/security.test.ts` | **ISSUE IDENTIFIED** | SB-13 — Imports compiled server.js absent in archive and not generated by declared build |
| `tests/signup-role.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/ssr.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/webhook.test.ts` | **ISSUE IDENTIFIED** | SB-10, SB-22 — Webhook test existence is not proof of real checkout/provider binding; not run |
| `tests/workspace-validation.test.ts` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `tests/workstream.test.ts` | **ISSUE IDENTIFIED** | SB-07, SB-18, SB-22, SB-24 — WorkStream retention/upload tests not run; cloud/local contract missing |
| `tsconfig.json` | No direct finding assigned | Not proof that the file is clean or every line was verified dynamically. |
| `vite.config.ts` | **ISSUE IDENTIFIED** | SB-32 — No API/WebSocket proxy and no Express runner |

## Part VI — Final remediation order

1. **Fix `SB-25` immediately:** change `gigRow.freelancer_id` to the correct typed `gigRow.freelancerId`; add route-level positive and negative ownership tests.
2. **Fix the core fee policy and centralize it (`SB-01`, `SB-02`, `SB-29`):** one server-side fee calculator, immutable per-order fee snapshots, tests at $199.99 / $200.00 / $200.01, and admin simulator using the same calculator.
3. **Fix payout idempotency (`SB-04`) and escrow/order atomicity (`SB-05`):** durable DB transactions, idempotency key to existing payout ID, no compensating order deletion after an irreversible funding commit.
4. **Unify every order creation path (`SB-03`, `SB-06`, `SB-16`, `SB-26`, `SB-28`, `SB-30`):** accepted project/owner binding, one new WorkStream per independent purchase, project-level acceptance race protection, publication checks, current protection setting, and restricted-account rules.
5. **Fix storage (`SB-07`, `SB-18`, `SB-23`, `SB-24`):** local/GCS-aware file service, ownership+target checks, safe URL policy, allowed extensions enforcement, reference-aware retention, and cloud object deletion.
6. **Fix auth/config/gateway controls (`SB-08`, `SB-09`, `SB-15`, `SB-31`):** enforce registration/email/password/KYC/payout settings; fail closed for secret encryption; await durable settings writes and only return success after persistence succeeds.
7. **Make build/dev/test reproducible (`SB-13`, `SB-20`, `SB-22`, `SB-32`, `SB-33`):** clean install, separate frontend/backend scripts or proper proxy, server build artifact, actual `test` script, CI test matrix, corrected source-scope test assertions, remove unsupported documentation PASS claims.
8. **Run fault-injection and end-to-end suites:** concurrent proposal acceptance; duplicate payout; webhook replay; order failure after every financial write; buyer/seller/outsider file permissions; repeated purchase same buyer/seller; refunds/disputes/withdrawals; settings update followed immediately by a funded transaction.
9. **Remove `data/pgdata/` from source/release ZIPs (`SB-14`):** use migrations + synthetic seeds, add ignore rules, and assess whether the shipped PostgreSQL files contain real sensitive data.

## Final statement

This is a more advanced static cross-file split-brain audit than the prior reports and has identified new concrete mismatches. It is not honest to call the application fully audited line-by-line or production-safe while the backend, database, payment provider, browser, and test suite have not run. Treat every runtime-only question as unverified until the documented reproduction/regression test is executed. No source code was modified by this audit.

---

# Historical appendix — Earlier baseline audit preserved verbatim

The following baseline report is included for traceability and to satisfy the request to combine all previously delivered reports. Its findings are already consolidated into SB-01 through SB-22 above. If its counts, severity wording, or scope description differ from the master summary, use the current master inventory and verification qualifications above as authoritative.

# FivePa / WorkPerHour — Split-Brain Audit Report
**Audit target:** `fivepa-freelance-marketplace (4).zip`  
**Audit date:** 24 October 2026  
**Audit type:** Source-archive static review, cross-layer consistency review, targeted security/financial-flow inspection  
**Status:** Initial deep audit completed on the available archive; runtime/build/test verification is **blocked**, so this is not a production certification.

## Executive summary

The archive contains a substantial React/TypeScript + Express/PostgreSQL marketplace. The audit examined the source tree, package/build configuration, fee calculation, order creation, proposal acceptance, workspace creation, authentication middleware, SSR public-data sanitization, route registration, persistence code, and test setup.

**Release recommendation: Do not treat this archive as production-ready until the critical findings below are resolved and the application is built and tested in a reproducible environment.**

The strongest confirmed discrepancy is the fee engine: the shared default configuration implements **20% commission, 1% buyer service fee, and $1 small-order fee**, with the service fee also suppressed for orders at or above $200. That conflicts with the established FivePa policy of **20% freelancer commission, 5.5% client service fee on top of the gig price, and an additional $3.50 fee only when the gig price is below $200**. The test file's title/comments describe the intended policy, but its assertions explicitly validate the incorrect 1%/$1 configuration. This is a specification-versus-implementation-and-test split-brain.

The archive also includes raw PostgreSQL data-directory artifacts, has no `npm test` script, and does not include a reproducible server build/start/test workflow in `package.json`. A fresh `npm test` invocation fails immediately with “Missing script: test.” Dependency installation timed out in this environment, so no claim is made that the build or test suite passed.

## Scope and evidence limits

### Archive inventory

- ZIP entries: 320 (including directory entries).
- Non-directory files: 271.
- Decodable text/source files reviewed by inventory scan: 221.
- Approximate text lines in those files: 64,141.
- Main code groups: `src/` frontend, `server/` backend, `src/server/` financial/workspace services, `tests/`, database migration, scripts, documentation, diagnostics, and package/lock files.
- The ZIP also includes `data/pgdata/` PostgreSQL internals, including `global/pg_control`, a WAL segment, and `postmaster.pid`.

### What was and was not verified

**Verified by source inspection:** literal configuration values, code paths and route guards visible in the archive, package scripts, test-runner wiring, source/data packaging, and the cited cross-layer inconsistencies.

**Not verified dynamically:** production HTTP behavior, race behavior under a running PostgreSQL instance, actual payment-provider callbacks, browser/UI behavior, live WebSocket delivery, build output, test pass counts, or the contents/meaning of binary PostgreSQL pages. `npm ci --ignore-scripts --no-audit --no-fund` timed out in the audit environment. No source files were modified.

A “split-brain” finding means two components, policy declarations, tests, or operational assumptions disagree. Severity reflects likely impact, not proof that an exploit has already occurred.

---

# Findings

## F-01 — Critical: Fee policy and fee engine disagree

**Evidence**
- `src/shared/fees.ts:16–21`: defaults are `commissionPercent: 20`, `buyerFeePercent: 1.0`, `smallOrderFee: 1.0`, `smallOrderThreshold: 200`.
- `src/shared/fees.ts:63–76`: comments and logic say buyer service fee applies only when the gig price is below the threshold; it is zero at/above $200.
- `src/server/siteSettings.ts:146–149`: comments claim 5.5% and $3.50, but values are inherited from the shared defaults (1% and $1).
- `tests/fees.test.ts:1`, `:29–44`, `:57`, `:86`: header describes 5.5%/$3.50, while assertions validate 1%/$1 and no service fee at $200/$500.

**Expected policy:** 20% freelancer commission; client service fee of 5.5% added to the gig price; separate $3.50 small-order fee only if the gig price is strictly below $200.

**Actual default behavior:** 20% commission; 1% service fee only on orders below $200; $1 flat fee only on orders below $200.

**Impact:** checkout totals, escrow funding requirements, invoice totals, platform revenue, refunds, and payout/reconciliation can all be wrong relative to the agreed business policy. Existing fee tests may pass while protecting the wrong policy.

**Required fix:** establish one authoritative fee configuration and use it in checkout quote, order creation, escrow funding/top-ups, refund reversals, invoices, admin reporting, and payout calculations. Correct the tests to assert the intended values and add boundary cases at $199.99, $200.00, and above $200. Do not merely edit comments.

## F-02 — Critical: Test and build workflow is not reproducible from package scripts

**Evidence**
- `package.json`: scripts include `dev`, `build`, `preview`, `clean`, and `lint`, but no `test` or `start`.
- A direct `npm test` attempt fails with `Missing script: "test"`.
- `tests/security.test.ts` imports `../server.js`, while the archive lists `server.ts` but no root `server.js`.
- `scripts/verify-build.mjs` expects a generated `server.js`, but the declared `build` command is only `vite build`; there is no declared script in `package.json` to compile `server.ts` to `server.js`.

**Impact:** a new checkout cannot run the advertised regression suite through the standard npm test command, and the security test's expected server artifact is not present in the archive. A test file existing is not evidence that it ran or passed.

**Required fix:** define a deterministic build pipeline that compiles the server and client/SSR outputs; define `test` scripts for each suite; ensure tests target the compiled artifact produced in the same run; document environment variables and database setup; make CI run build, typecheck, unit tests, integration tests, and security tests from a clean checkout.

## F-03 — High: PostgreSQL runtime data is packaged with the source archive

**Evidence**
- `data/pgdata/` is included in the ZIP, including PostgreSQL internal files, `global/pg_control`, a WAL segment, and `postmaster.pid`.
- `.gitignore` excludes build artifacts and `.env*`, but does not exclude `data/pgdata/`.

**Impact:** a source ZIP should not normally ship a live database data directory. It can disclose user/order/message/financial data if the database pages contain real records; it can also contain environment-specific state and make the project non-portable or unsafe to start. The binary pages were not decoded, so this audit does **not** claim that a specific person's data was recovered.

**Required fix:** remove database runtime files from source control and release ZIPs; add `data/pgdata/` and other runtime storage to `.gitignore`; use schema migrations plus explicitly synthetic seed data for development; if this archive was shared externally, determine whether the database contains real personal or financial data and follow the appropriate incident-response process.

## F-04 — High: Financial truth is spread across multiple engines and configuration surfaces

**Evidence**
- `src/shared/fees.ts` provides shared fee math.
- `src/server/financeLedger.ts` contains a separate ledger engine and its own configurable fee properties.
- `server/services/financialService.ts` performs PostgreSQL-based escrow and ledger operations and reconstructs fee configuration from site settings/defaults.
- `server/routes/orderRoutes.ts` sets `feeBreakdown` using `calculateOrderFees(rawAmount, DEFAULT_FEE_CONFIG)`.
- `server/routes/proposalRoutes.ts` uses `financeLedger.quoteOrder(proposal.bidAmount)` when constructing a proposal order.
- `server/routes/financialRoutes.ts` contains fallback calculations from `DEFAULT_FEE_CONFIG`.

**Impact:** a change in one fee source may not propagate to all order paths. Gig purchases and proposal acceptance can quote fees through different functions, while database escrow funding and admin settings can have separate sources of values. That creates a risk that checkout, order records, escrow ledger, refunds, invoices, and admin dashboards disagree.

**Required fix:** select a single canonical fee calculator/configuration and inject/use it across both in-memory and PostgreSQL financial flows. Persist the exact fee breakdown and fee-policy version on the order at funding time; later releases/refunds must reverse the stored values rather than silently recalculating with current settings.

## F-05 — High: Generic order creation can reuse a supplied workspace for non-gig orders

**Evidence**
- `server/routes/orderRoutes.ts` order creation: gig purchases call `workspaceService.createWorkspaceAsync(...)` to create a new workspace.
- For non-gig orders, when `req.body.workspaceId` is supplied, the route loads that workspace and checks that buyer/seller match, then assigns the existing workspace to the new order.
- `src/server/workspaceService.ts:141–177` intentionally adds an order to the workspace's `orderIds` list when `ensureWorkspaceForOrderAsync` receives an order with an existing workspace ID.

**Impact:** if this generic route is used to create a separately purchased project/order, matching buyer and seller are sufficient to attach the new order to an existing WorkStream. That is inconsistent with the business invariant that every separately purchased Gig or separately accepted Project gets its own Order + WorkStream + Escrow. Proposal acceptance appears to create a new workspace in its own path, but the generic endpoint still needs an invariant check.

**Required fix:** do not accept a caller-supplied workspace ID for a new separately purchased gig/project. Create a fresh workspace server-side for every new transaction. Permit reuse only for updates/final submissions tied to the same existing order ID, and assert that order, workspace, buyer, seller, and escrow identifiers match. Add tests with the same buyer/seller purchasing two projects and two gigs concurrently.

## F-06 — High: The archive is not sufficient to certify escrow/order atomicity under failure

**Evidence**
- `server/routes/orderRoutes.ts` persists the new order before attempting escrow funding; on funding failure it deletes the order/messages and may delete an empty workspace.
- `server/routes/proposalRoutes.ts` likewise persists the order/offer and then funds escrow, with compensating deletes on funding failure.
- Financial persistence uses multiple transactional routines in `server/services/financialService.ts` and `server/db/postgresStore.ts`, but this review could not execute the integration/race suite against a running database.

**Impact:** compensating cleanup is not equivalent to one database transaction spanning order, workspace, offer, escrow, journal entries, and wallet movements. Failures between operations can leave orphaned workspace/offer/message rows or partially synchronized in-memory and database state unless every operation is idempotent and cleanup is complete.

**Required fix:** use a database transaction or durable state machine/outbox for the order-funding workflow. Add fault-injection tests that fail after each write, then verify no duplicate order, escrow, ledger journal, wallet movement, offer, or workspace remains. Verify retries with the same idempotency key.

## F-07 — High: Live financial and security behavior remains unverified

**Evidence**
- The test suite includes `tests/concurrency-race-stress.test.ts`, `tests/ledger.safety.test.ts`, `tests/security.test.ts`, `tests/webhook.test.ts`, and `tests/workstream.test.ts`.
- Dependency installation timed out in this environment; the test runner is not wired to `npm test`; therefore these tests were not executed here.

**Impact:** there is no defensible claim from this audit that concurrency, double-release prevention, refund behavior, webhook signatures, authorization boundaries, or WorkStream isolation passed in the uploaded build.

**Required fix:** run the suites in a reproducible CI environment and attach logs/results to a specific commit/archive hash. For financial endpoints, include database-level assertions on ledger balance and exactly-once effects, not only HTTP status assertions.

## F-08 — Medium: Product documentation and actual project identity/configuration are inconsistent

**Evidence**
- `README.md` is the generic Google AI Studio starter README, instructing the developer to configure `GEMINI_API_KEY` and run the Vite dev server.
- `package.json` names the project `react-example`, version `0.0.0`.
- `TABLE_OF_CONTENTS.md` describes a “Commercial Release 1.0” and architecture/components not all present in the archive (for example, its listed Next.js templates/config are not present in the file inventory).

**Impact:** maintainers may follow incorrect run/deploy instructions or believe architectural components exist when they are not in the release archive. The docs do not provide a reliable release checklist or deployment runbook for the actual Express/PostgreSQL app.

**Required fix:** replace starter documentation with the real app name, architecture, required env vars, database lifecycle, migration process, build/run/test commands, payment webhook setup, storage configuration, backups, and deployment health checks. Generate the file inventory from the actual repository during release.

## F-09 — Medium: Production security posture cannot be fully established from this archive

**Evidence**
- `server/middleware/auth.ts` has an environment-driven JWT secret guard for production and a custom HMAC token implementation.
- Rate limiting is present on selected sensitive routes, including login-adjacent and financial actions, but it is applied per route rather than through one obvious global API policy.
- The code sets a few response headers in `server.ts`, but no `helmet` dependency or explicit CSP middleware appears in the package/config scan.
- `.env.example` contains placeholders rather than a real key; no hard-coded production credential was confirmed by the quick literal scan.

**Impact:** a static scan cannot establish secret rotation, production cookie/token storage, reverse-proxy IP handling, brute-force controls across all routes, CSP coverage, or deployment TLS behavior. Absence of a specific dependency is not by itself proof of a vulnerability.

**Required fix:** document and test production secret requirements; add security headers/CSP appropriate to the app; centrally audit rate limits for login, verification-code endpoints, password reset, messages/uploads, checkout, withdrawals, and admin actions; run dependency and secret scanning in CI; verify the actual deployed TLS/proxy configuration.

## F-10 — Medium: Admin configuration and runtime fee comments can mislead operators

**Evidence**
- `src/server/siteSettings.ts:147–149` comments say “5.5% client service fee” and “$3.50 flat fee,” while the referenced defaults resolve to 1% and $1.
- `server/routes/adminRoutes.ts` audit-log text describes values from flattened settings, so an admin may see labels that look like the intended fee policy while the actual defaults remain different.

**Impact:** an operator may believe the intended fee policy is active based on comments or labels, while transactions calculate different amounts.

**Required fix:** after correcting the canonical policy, ensure admin forms, persisted settings, backend validation, quote preview, transaction records, and audit logs all show the exact active configuration. Display effective settings and the fee-policy version.

## F-11 — Medium: Static archive review cannot prove every user-visible feature is wired end to end

**Evidence**
- The repository has broad UI coverage (marketplace discovery, gig/project details, profiles, admin modules, payments, and many WorkStream components/hooks) and many backend routes/services.
- The current audit environment did not run a browser, a live backend, WebSockets, storage uploads, or a payment sandbox.

**Impact:** the presence of a React component or route does not prove its action is connected correctly, permission-checked, persisted, and reflected in all other views. Visual states, stale client state, upload permissions, notification delivery, and realtime reconnect behavior need integration tests.

**Required fix:** add end-to-end tests for the key user journeys listed below and run them against a clean database and test payment/storage providers.

---

# Cross-layer split-brain matrix

| Area | Source-level result | Status |
|---|---|---|
| Fee policy | Code defaults and test assertions are 1% + $1, not 5.5% + $3.50; service fee disappears at $200+ | **Confirmed mismatch — Critical** |
| Gig order | Route creates a new workspace for gig orders and then attempts escrow funding | Partially consistent; failure atomicity not dynamically verified |
| Proposal acceptance | Builds an order and workspace, then funds escrow and updates proposal/project state | Partially consistent; failure atomicity and race behavior unverified |
| Generic project/custom order | Caller-supplied workspace can be reused when buyer/seller match | **Invariant gap — High** |
| Financial ledger | Multiple financial implementations/configuration surfaces exist | **Drift risk — High** |
| Authentication | Shared token verification middleware is mounted at `/api`; route-level auth guards exist | Static review only; not dynamically certified |
| Admin/impersonation | Admin routes and UI exist; privileged paths are represented in tests | Not run; requires full impersonation/session-expiry test |
| WorkStream messages/files/delivery/revisions | Many dedicated routes, hooks, and UI modules exist | Wiring, permissions, persistence, and realtime not end-to-end verified |
| Refunds/disputes/withdrawals | Dedicated financial routes/services and tests exist | Not run; monetary invariants not certified |
| SSR/public data | SSR applies public filters and sanitizers to users/gigs/projects before rendering | Positive design signal; requires regression tests for newly added fields |
| Build/test/release | No `test`/`start` script; security test expects missing `server.js` artifact in archive | **Reproducibility gap — Critical** |
| Database packaging | Raw PostgreSQL data files are shipped with source | **Packaging/privacy risk — High** |
| Docs/release identity | Generic AI Studio README and `react-example` package identity do not match the commercial marketplace docs | **Documentation drift — Medium** |

---

# Required end-to-end regression plan

These are the minimum release-blocking journeys. Each test should assert the HTTP/UI result **and** the durable database/ledger state.

1. **Authentication and session security**
   - Signup, email/SMS verification, login, password reset, logout/session invalidation, suspended/restricted users, admin and super-admin permissions, impersonation start/stop, and expiry.
   - Confirm user-supplied IDs never override the authenticated identity.

2. **Independent transaction isolation**
   - Same buyer purchases the same gig twice from the same seller.
   - Same buyer purchases two different gigs from the same seller.
   - Same buyer accepts two separate projects from the same seller.
   - Verify each transaction has its own Order, WorkStream, escrow record, and journal references.
   - Verify a final submission/invoice for an existing order does not create another order or escrow.

3. **Fee and checkout correctness**
   - Verify 20% commission and 80% freelancer net.
   - Verify 5.5% client service fee on the gig price at all applicable order sizes.
   - Verify the additional $3.50 small-order fee applies only when gig price is below $200, not at exactly $200 or above.
   - Test extras, custom orders, proposals, top-ups, cancellation, full/partial refunds, invoices, payout, and admin reporting against the same stored breakdown.

4. **Escrow and ledger integrity**
   - Insufficient wallet balance, funding success, duplicate requests, concurrent funding/release, repeat release, refund after delivery, disputed order, cancelled/completed order, and process crash at each persistence boundary.
   - Assert double-entry balance, exactly-once wallet movements, and no release/refund exceeding remaining escrow.

5. **WorkStream authorization and messaging**
   - Buyer, seller, unrelated user, support, admin, and impersonated user access checks.
   - Messages, attachments, links, drafts, revisions, offers, delivery, invoice, buyer approval, auto-accept, video-call signaling, and realtime reconnect.
   - Verify no participant can access another order's files/messages by changing an order/workspace ID.

6. **Projects and proposals**
   - Create project, submit proposal, accept/decline, concurrent acceptance attempts, acceptance with insufficient funds, cancelled project, and duplicate retry.
   - Verify only the correct proposal becomes accepted and all related order/workspace/escrow records remain consistent.

7. **Payouts, refunds, disputes, and webhooks**
   - Idempotent webhook replay, invalid signature, payout state transitions, withdrawal verification, refund reconciliation, dispute hold/release, and audit trail.
   - Verify the ledger and visible balances agree after every transition.

8. **Marketplace and admin**
   - Gig publish/edit/delete/moderation, project visibility, profile privacy, search/filter/pagination, reviews, notifications, support tickets, CMS/categories, user suspension, and admin settings.
   - Confirm public SSR never exposes private user fields and admin-only APIs reject ordinary users.

9. **Operations and recovery**
   - Clean install, migrations on an empty database, restart/hydration, database unavailable, graceful shutdown, backup/restore, upload storage failure, background job retry, and recovery from partially completed transactions.

---

# Immediate remediation order

1. **Correct and centralize fee math**; fix misleading comments and tests; verify all checkout/escrow/refund/invoice/payout surfaces.
2. **Remove raw PostgreSQL runtime data from the archive/repository** and determine whether it contains real data.
3. **Make build and tests reproducible** from a clean checkout; wire `npm test`, server compilation, and a documented start command.
4. **Enforce one Order + one WorkStream + one Escrow per separately purchased transaction**, including the generic order route; keep final submissions on the existing order.
5. **Run the concurrency, ledger, security, webhook, and WorkStream suites** in CI and record exact pass/fail output against this archive/commit.
6. **Run browser-level end-to-end tests** across buyer, freelancer, and admin journeys.
7. **Replace starter docs** with accurate run/deploy/security/backup instructions.

## Final verdict

This archive shows substantial implementation work and has dedicated code/tests for many important concerns, but the available evidence does **not** support calling it fully audited, fully tested, or production-safe. The confirmed fee-policy split-brain and missing reproducible test workflow are release blockers. The workspace-reuse path and bundled PostgreSQL files also need immediate attention. All remaining unexecuted runtime behavior should be marked **Unverified**, not “Passed.”

**Audit confidence:** High for the specific source-level discrepancies and package findings cited above; limited for runtime security, financial race behavior, browser wiring, and production deployment because the test/build workflow could not be executed in this environment.


---

**End of master report.** The authoritative consolidated findings are **SB-01 through SB-33** in this master audit. The companion `FivePa_Master_File_Inventory.md` and `FivePa_File_Level_Split_Brain_Matrix.csv` identify archive entries assigned to findings and entries with no direct finding assigned. Historical reports are preserved for traceability, not as additional unique findings. The audited ZIP SHA-256 is recorded in the report. Runtime and end-to-end behavior remains unverified where explicitly stated; a file marked “No direct finding assigned” is not thereby certified defect-free.
