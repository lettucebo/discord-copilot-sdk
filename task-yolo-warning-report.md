## 2026-08-12
- Added command-level regression coverage in `test/app-channels.test.ts` for `/yolo mode:on`.
- Verified the command emits the live transport notice mentioning `discord_send_file` fast-deny and `/file path:<file>` guidance.
- Verified the command path still keeps YOLO disabled until the acknowledgement path completes.
- Verification:
  - `npx vitest run test/app-channels.test.ts -t "keeps /yolo mode:on gated on the ack and then emits the live notice with file guidance"`
  - `npm run typecheck`
