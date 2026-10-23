# Content-pinned SKILL.md catalogs

Ordinary `skillDirs` discovers skills on disk and exposes the index plus on-demand instruction/reference tools. A long-running recoverable task needs the same catalog after its original files change or disappear. `SkillMdManager.createSnapshot` captures text assets for that task without putting every instruction into the model prompt.

```ts
import { Agent, SkillMdManager } from "@agentium/core";

const skills = new SkillMdManager({ dirs: ["./skills"] });
const snapshot = await skills.createSnapshot({ maxFiles: 100, maxBytes: 1_000_000 });
// Commit the complete snapshot with the immutable run seed before dispatch.
const agent = new Agent({ name: "analyst", model, skillSnapshot: snapshot });
```

The snapshot contains a format version, names, exact UTF-8-decoded file text and a SHA-256 content identity. It contains no local directory paths. Import validates the digest, metadata, unique names and reference paths. Capture is bounded before file content is loaded, refuses symbolic links, and fails without truncating a catalog when a caller-selected limit is exceeded. Store the complete payload with access controls appropriate for the skill content; a digest alone cannot restore missing text. Digests detect inconsistent content, not unauthorized changes by someone who can rewrite both the payload and digest.

`new SkillMdManager({ snapshot })` and `Agent({ skillSnapshot })` use only retained text. `list_skills`, `get_skill_instructions` and `get_skill_reference` continue progressive disclosure; references never fall back to a newer filesystem version. Configure a snapshot or nonempty `skillDirs`, not both. A harness definition with `skillDirs` defaults must explicitly override those defaults with `skillDirs: false` when supplying a snapshot.

This preserves skill identity only. It does not replay a model, restore a native loop or make the static graph accept dynamic skills. `getRecoveryDescriptor` still rejects `skillSnapshot` for that graph path. A full recovery adapter must also pin the executable tools, context and policy versions and record exactly which skill text each historical model request received.
