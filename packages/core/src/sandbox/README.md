# Workspace and cloud sandbox contracts

`SandboxAgent` keeps an owned workspace across explicit calls. `unix-local` runs trusted code with the host user's privileges; temporary directories and path checks do not isolate programs from the host. The removed `docker` selector fails before creating files or spawning processes. There is no Docker implementation or fallback. `remote` delegates to an explicitly supplied `CloudSandbox` and owns that port's start/close lifecycle.

```ts
import { SandboxAgent } from "@agentium/core";
const workspace = new SandboxAgent({
  backend: "unix-local",
  workspace: { files: [{ path: "input.txt", contents: "hello" }] },
  maxOutputBytes: 64 * 1024,
});
try {
  await workspace.start();
  const result = await workspace.run('console.log(process.cwd())', {
    language: "node",
    timeoutSeconds: 5,
    signal: requestSignal,
  });
  console.log(result);
} finally {
  await workspace.close();
}
```

Local `run` sends Node/Python source as interpreter arguments without a shell wrapper. `shell` and `run(...,{language:"shell"})` explicitly interpret shell syntax. Git manifest clones/checkouts use separate argument arrays; initialization failure deletes its partial workspace. Only PATH and explicitly selected `inheritEnv`, workspace env and run env values reach child processes. File helpers and manifests use canonical ancestor checks; missing files return null, while denied paths, dangling/external links and read errors reject. Arbitrary programs and hostile concurrent path replacement remain outside these checks.

Starts are serialized. Closing rejects new work, kills active local process groups, waits for their inherited output pipes to close, then removes the workspace. Local timeout returns `timedOut:true, exitCode:124`; cancellation returns `cancelled:true, exitCode:130`. Output overflow terminates the group and sets `outputTruncated:true`. Detached descendants that deliberately escape the group are outside this trusted local execution contract. Windows does not support this backend. A snapshot copies regular files (at most 1,000 files / 16 MiB); symlinks are omitted. Resume closes the prior workspace before recreating snapshot files; initial git clones are not replayed. Remote snapshots reject because a manifest cannot represent provider execution state.

## Optional cloud adapters

```ts
import { E2BSandbox, DaytonaSandbox } from "@agentium/core/toolkits";
// SDK import and resource creation occur only on start/first operation.
const python = new E2BSandbox({ lifetimeSeconds: 300, defaultTimeoutSeconds: 30 });
const javascript = new DaytonaSandbox({ language: "node", defaultTimeoutSeconds: 30 });
try {
  await python.run('print("hello")');
  await javascript.run('console.log("hello")');
} finally {
  await Promise.all([python.close(), javascript.close()]);
}
```

| Adapter | Verified SDK | Mappings |
| --- | --- | --- |
| E2B | `@e2b/code-interpreter@2.8.0` | Interpreter SDK default template; `runCode` with `python`/`javascript`, `envs`, millisecond timeouts; `commands.run`; byte reads/writes; `kill` |
| Daytona | `@daytona/sdk@0.220.0` | `Daytona({apiUrl})`, `create({language,name})`; `process.codeRun` / `executeCommand` with seconds; `fs.uploadFile(Buffer,path)` / `downloadFile`; `delete(timeout,true)` |

E2B's default template comes from the interpreter SDK rather than overriding it with a generic base image. Daytona language is fixed at creation; cross-language code calls reject before dispatch. Configure distinct adapters for Python and Node. `workspace` maps to an optional Daytona sandbox name; omission allows provider-generated names. Daytona defaults to five minutes of inactivity before auto-stop and deletion after stop; normal ownership still requires explicit close. E2B's five-minute lifetime is separate from each operation's timeout.

Missing methods reject before tool dispatch. Concurrent starts create one sandbox, closing waits for outstanding SDK operations, and repeated close does not delete twice. Closing is terminal; make a new adapter to create another sandbox. Every created sandbox is adapter-owned. An injected Daytona client is borrowed and is not disposed; a constructed client is disposed with its owner. Injected E2B SDK modules are factories, not borrowed sessions. SDK creation failures may have unknown remote outcomes if the provider created a sandbox without returning its identity; inspect the provider account before retrying ambiguous creation failures.

Nonzero command exits remain nonzero, code exceptions produce failure output, and only provider-specific file-not-found errors become null. Auth failures, network failures and missing sandbox errors reject. Bytes preserve base64 round trips. Captured return output defaults to 1 MiB (`maxOutputBytes`, maximum 16 MiB) with truncation diagnostics. This limits Agentium's returned output; these SDK methods can buffer more data internally before returning. It is not a provider memory quota.

Signals reject pre-aborted operations before creation and are checked again after remote calls settle. E2B command requests also receive the SDK signal; its interpreter call and Daytona's process methods do not expose an equivalent per-call abort port. Cancellation or a client request timeout is **not proof that remote code stopped**; such errors propagate without manufacturing a successful termination result. Closing awaits these bounded SDK calls before resource deletion. Do not automatically replay uncertain external effects through a durable ledger without connector evidence. Toolkit run/shell operations forward their execution context signal.

## Verification and live gate

Official contracts: [E2B interpreter source](https://github.com/e2b-dev/code-interpreter), [E2B sandbox SDK](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox), [Daytona process methods](https://www.daytona.io/docs/en/typescript-sdk/process/), [Daytona filesystem methods](https://www.daytona.io/docs/en/typescript-sdk/file-system/). Installed exact package declarations and implementations were checked alongside these references on 4 October 2026. The E2B documentation URL describes the base SDK; the pinned interpreter package and its bundled declarations establish the tested interpreter contract.

Deterministic fixtures exercise method admission, binary content, errors, timeouts, language selection, environment variables, cancellation and resource ownership. The opt-in fixture runs actual SDK create/code/files/delete implementations (plus Daytona commands) against a loopback HTTP server with synthetic responses. It uses a test-only Daytona polling mode so no WebSocket deployment is needed. E2B command mapping has SDK-shaped fixtures; its remote process transport is not live-certified.

```sh
npm install --prefix /tmp/agentium-sandbox-sdk-fixture --no-audit --no-fund @e2b/code-interpreter@2.8.0 @daytona/sdk@0.220.0
AGENTIUM_SANDBOX_SDK_PREFIX=/tmp/agentium-sandbox-sdk-fixture npx vitest run packages/core/src/toolkits/__tests__/sandbox-sdk.integration.test.ts
```

This gate needs no account credentials and creates no cloud resources. Live certification remains gated on an explicitly approved test account, fixed template/resource count, a short lifetime/time budget, an agreed spend ceiling, and provider-side cleanup verification in `finally`. No such account was used for this implementation. Real provider isolation, quota behavior, remote termination and network failure recovery remain live-service checks.
