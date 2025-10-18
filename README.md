# Digital Organiser – File Hierarchy Sandbox

This project extends the Electron React Boilerplate with an interactive, sandboxed
file hierarchy preview. The renderer supplies a React-based tree editor that lets
you experiment with large directory snapshots, queue kind-aware diffs, and only
commit changes after an explicit confirmation.

## Architecture

```
+------------------------------- Desktop (Electron) --------------------------------+
|                                                                                  |
|  +-----------------+          IPC (invoke/handle)         +-------------------+  |
|  | Renderer (React)| <-----------------------------------> | Main (Node/Python)| |
|  |  - Tree Sandbox UI        requestSnapshot(root)        |  - Snapshot mock    |
|  |  - Diff Panel (kind aware) previewDiff(diff)           |  - Diff echo        |
|  |  - Domain state helpers    applyDiff(diff)             |  - Future FS bridge |
|  +---------^-------+                                        +---------^---------+|
|            |                                                      |              |
|            | in-memory tree (sandbox)                             | filesystem   |
|            | CRUD ops -> domain layer (all ops carry kind)        | read/write  |
|  +---------+---------------------+                          +------+-------------+
|  |        Domain Library         |                          |  OS File System   |
|  |  - Tree model (IDs, parents)  |                          |  (NTFS/APFS/etc.) |
|  |  - Traversals (DFS/BFS)       |                          +-------------------+
|  |  - Path normaliser            |
|  |  - Diff engine (coalesce, dep, kind-aware)
|  |  - Undo/Redo stack            |
|  +-------------------------------+
```

### Domain library

All algorithms live under `src/renderer/fileSandbox/` and are written in
TypeScript so they can be shared between the UI and tests.  The Jest suite in
`src/__tests__/fileSandbox.test.ts` exercises the complete surface:

| Concern | Implementation | Tests |
| --- | --- | --- |
| Snapshot hydration, DFS/BFS traversal, parent invariants | `tree.ts` | `builds a consistent sandbox tree...` |
| Path normalisation and validation | `path.ts` | `normalises windows and posix paths...` |
| Kind-aware CRUD (create/move/rename/delete) | `tree.ts` | `creates files and folders respecting kind...` |
| Diff generation (deterministic, kind annotated) | `diff.ts` | `diff() emits rename with explicit kind...` |
| Conflict handling (auto-suffix, merge) | `tree.ts` | `auto suffixes duplicate file names...` |
| Undo/redo stack (O(1) history) | `undoRedo.ts` | `tracks inverses of operations...` |
| IPC bridge preview/apply stubs | `store.ts` | `sends diffs containing kind metadata...` |

### UI highlights

The renderer is implemented in `src/renderer/fileSandbox/FileSandboxApp.tsx` and
styled via `src/renderer/App.css`. Key behaviours:

- Virtualised tree renderer with inline rename, HTML drag-and-drop and multi
  select.
- Toolbar + contextual menu for “New Folder”, “New File”, “Rename”, “Delete” and
  “Move to…”.
- Live diff panel (human readable + JSON) generated from the sandbox tree
  without mutating the base snapshot.
- Undo/redo buttons backed by the shared history stack.
- Status bar that tracks selection counts, pending operations and whether you
  have unsaved changes.
- A mocked IPC bridge (see `src/main/main.ts` and `src/main/preload.ts`) that
  serves a sample snapshot and echoes diff previews/applies.

## Getting started

Install dependencies once and run the development environment:

```bash
npm install
npm start
```

The renderer boots with a sample snapshot. You can refresh the sandbox with the
“Load sample snapshot” button or, in a real deployment, swap the IPC handlers to
call your backend.

## Testing

Run the full Jest suite:

```bash
npm test
```

The tests focus on the domain library so that reviewers can reason about the
algorithms directly from the fixtures. Coverage emphasises path normalisation,
conflict resolution, diff determinism and IPC contract echoes.

## Folder map

```
src/
  ├─ renderer/
  │   ├─ App.tsx                → wraps FileSandboxApp
  │   ├─ App.css                → sandbox layout and theme
  │   └─ fileSandbox/
  │        ├─ FileSandboxApp.tsx → React UI, undo/redo wiring, context menu
  │        ├─ diff.ts             → diff generation
  │        ├─ path.ts             → path utilities
  │        ├─ store.ts            → lightweight state container + IPC facade
  │        ├─ tree.ts             → sandbox tree operations
  │        └─ undoRedo.ts         → bounded history stack
  ├─ main/
  │   ├─ main.ts                → adds sandbox IPC handlers
  │   └─ preload.ts             → exposes sandbox API to renderer
  ├─ common/
  │   └─ sandboxSample.ts       → reusable snapshot fixture
  └─ __tests__/
      └─ fileSandbox.test.ts    → behavioural and algorithmic tests
```

## Licence

MIT – see [LICENSE](LICENSE).
