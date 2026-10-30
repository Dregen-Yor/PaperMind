# Runtime security implementation plan

**Goal:** Apply the approved October 2026 runtime remediation without claiming an unpatched Electron release is safe.

**Execution:** Inline, in order, on `fix/runtime-security-baseline`; no commit, push or publication is included in this request.

**Constraints:** Node 24.22.1 LTS is the build baseline. Electron must have independently verified security approval before packaging or publication. Existing local data and cached reports must remain readable.

1. [x] Install verified official Node 24.22.1 in the user's runtime directory; pin `.nvmrc`, engines and CI. Add tested startup/build version checks.
2. [x] Pin the current Electron 44 stable maintenance release exactly. Add a fail-closed runtime policy and inspect the real executable, including builder `afterPack` inspection. No approved Electron release is currently established.
3. [x] Block Node network transport on unsafe Node runtimes before connecting. Validate service URLs before normalization; require HTTPS except explicit loopback; forbid redirects and bound response bodies, uploads, deadlines and concurrency.
4. [x] Restrict every IPC channel to the registered application main frame and expected renderer URL. Explicitly preserve sandbox, context isolation and disabled Node integration.
5. [x] Exercise unsafe versions, redirect/size/timeouts, remote HTTP, malformed hosts and untrusted IPC callers. Run typecheck, all tests, frontend/main/preload bundling, runtime audit and packaging rejection. Document residual runtime risk and local artifact versions.

**Review focus:** imported endpoint settings, streaming model responses, local Ollama/Docling support, child-frame IPC, and inspection of actual packaged runtimes rather than package metadata.

**Release limitation:** No runtime-policy override or automatic approval of new Electron releases. Remove the block only after official patch evidence, runtime inspection and compatibility verification.


**Outcome:** Local implementation and verification completed. Build Node is 24.22.1; Electron 44.9.3 embeds Node 24.22.0 and remains intentionally unapproved. Native Docling networking and installer publication fail closed until an official patched Electron is verified. Full tests, typecheck, bundling and real Electron sandbox/CSP smoke passed. npm audit was unavailable (socket hang up), and cross-platform packaging remains unverified. See `docs/testing/runtime-security-2026-10-22.md` for evidence and reopening criteria.
