export function createSideQuestionNativeAppConfig() {
  return {
    enabled: true,
    links: {
      account: { approvals_reviewer: "auto_review", default_tools_approval_mode: "approve" },
    },
    tools: {
      write: { enabled: false, approval_mode: "approve" },
      read: { approval_mode: "approve" },
      retired: { approval_mode: "approve" },
    },
  };
}

export function createSideQuestionNativeToolInventory() {
  return {
    data: [
      {
        name: "codex_apps",
        tools: {
          write: {
            name: "write",
            annotations: { readOnlyHint: false },
            _meta: { connector_id: "ask-app" },
          },
          "false.read": {
            name: "false.read",
            annotations: { readOnlyHint: true },
            _meta: { connector_id: "false-app" },
          },
        },
      },
    ],
    nextCursor: null,
  };
}
