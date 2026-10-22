(() => {
  // dsh-plugin/i18n/api.mjs
  function t(source, values) {
    const runtime = globalThis.window?.__DSH_I18N__;
    if (runtime) return runtime.t(source, values);
    return typeof source === "string" ? source.replace(/\{(\w+)\}/g, (match, key) => values?.[key] ?? match) : source;
  }
  function useLocale(React) {
    globalThis.window?.__DSH_I18N__?.use(React);
  }

  // dsh-plugin/desktop-maintenance/model.mjs
  var REPORT_TTL_MS = 5 * 60 * 1e3;
  function isCurrent(report, identity, now = Date.now()) {
    return report?.schema === 1 && report.runtime?.backendInstance === identity?.backendInstance && Number.isFinite(report.observedAt) && now >= report.observedAt && now - report.observedAt <= REPORT_TTL_MS;
  }
  function statusLabel(status) {
    return { checking: "\u68C0\u6D4B\u4E2D", available: "\u53EF\u7528", limited: "\u53D7\u9650", unavailable: "\u4E0D\u53EF\u7528", unknown: "\u672A\u77E5" }[status] || "\u672A\u77E5";
  }
  var featureLabels = {
    diagnostics: "\u6545\u969C\u8BCA\u65AD",
    "window-notifications": "\u7A97\u53E3\u4E0E\u901A\u77E5",
    "terminal-dock": "\u7EC8\u7AEF\u4E0E\u505C\u9760",
    "session-changes-git": "\u4F1A\u8BDD\u66F4\u6539\u4E0E Git",
    "file-editor": "\u6587\u4EF6\u7F16\u8F91",
    "appearance-settings": "\u5916\u89C2\u4E0E\u8BBE\u7F6E",
    "plugin-management": "\u63D2\u4EF6\u7BA1\u7406",
    "ui-recovery": "\u8349\u7A3F\u4E0E\u754C\u9762\u6062\u590D",
    "lan-mobile": "\u5C40\u57DF\u7F51\u4E0E\u624B\u673A",
    "session-links-export": "\u4F1A\u8BDD\u5F15\u7528\u4E0E\u5BFC\u51FA",
    "backup-restore": "\u5907\u4EFD\u4E0E\u6062\u590D",
    "runtime-rollback": "\u8FD0\u884C\u65F6\u56DE\u9000"
  };
  var checkLabels = { node: "Node.js", npm: "npm", "dsh-entry": "dsh \u5B89\u88C5", "data-roots": "\u6570\u636E\u76EE\u5F55", webview: "WebView2" };
  var verificationLabels = {
    "settings-zh-en": "\u4E2D\u82F1\u6587\u8BBE\u7F6E",
    "vanilla-navigation": "\u539F\u7248\u5916\u89C2\u5165\u53E3",
    "local-error-page": "\u672C\u5730\u6545\u969C\u9875",
    "light-dark": "\u660E\u6697\u4E3B\u9898",
    "mobile-host-restrictions": "\u624B\u673A\u5BBF\u4E3B\u6743\u9650\u9650\u5236",
    "native-diagnostics-acl": "\u539F\u751F\u8BCA\u65AD\u6743\u9650",
    "feature-contract-reporting": "\u5B9E\u9645\u529F\u80FD\u63A5\u53E3\u62A5\u544A",
    "stale-page-rejection": "\u65E7\u9875\u9762\u8EAB\u4EFD\u62D2\u7EDD",
    "dual-configuration-restore": "\u53CC\u7EC4\u4EF6\u914D\u7F6E\u6062\u590D",
    "preview-revision-rejection": "\u9884\u89C8\u540E\u4FEE\u6539\u62D2\u7EDD",
    "required-ui-ack-rollback": "\u5FC5\u8981\u754C\u9762\u786E\u8BA4\u5931\u8D25\u56DE\u6EDA",
    "cold-interruption-rollback": "\u51B7\u542F\u52A8\u4E2D\u65AD\u56DE\u6EDA",
    "external-edit-quarantine": "\u5916\u90E8\u7F16\u8F91\u51B2\u7A81\u9694\u79BB",
    "cold-draft-attachment-recovery": "\u8DE8\u91CD\u542F\u8349\u7A3F\u4E0E\u9644\u4EF6\u6062\u590D",
    "newer-draft-conflict": "\u65B0\u8349\u7A3F\u51B2\u7A81",
    "maintenance-exclusion": "\u7EF4\u62A4\u4E92\u65A5",
    "acknowledged-cleanup": "\u786E\u8BA4\u540E\u6E05\u7406",
    "workspace-git-selection": "Git \u4E0E\u975E\u4ED3\u5E93\u5DE5\u4F5C\u533A\u5207\u6362",
    "empty-session-selection": "\u7A7A\u9875\u9762\u4F1A\u8BDD\u9009\u62E9",
    "disabled-enhancement-intent": "\u53EF\u9009\u589E\u5F3A\u5173\u95ED\u610F\u56FE",
    "session-controller-selection": "\u4F1A\u8BDD\u5F15\u7528\u4E0E\u5BFC\u51FA\u63A5\u53E3\u9009\u62E9",
    "notification-service-initialization": "\u539F\u751F\u901A\u77E5\u670D\u52A1\u521D\u59CB\u5316",
    "cold-terminal-explicit-skip": "\u51B7\u6062\u590D\u660E\u786E\u8DF3\u8FC7\u7EC8\u7AEF\u72B6\u6001",
    "cold-terminal-package-retention": "\u8DF3\u8FC7\u7EC8\u7AEF\u540E\u4FDD\u7559\u539F\u6062\u590D\u5305",
    "background-draft-attachment-checkpoint": "\u540E\u53F0\u8349\u7A3F\u4E0E\u9644\u4EF6\u68C0\u67E5\u70B9",
    "same-page-checkpoint-replacement": "\u540C\u9875\u9762\u68C0\u67E5\u70B9\u66FF\u6362",
    "native-checkpoint-throttle": "\u539F\u751F\u68C0\u67E5\u70B9\u9891\u7387\u9650\u5236",
    "draft-only-cold-recovery": "\u4FDD\u7559\u9875\u9762\u9009\u62E9\u7684\u8349\u7A3F\u51B7\u6062\u590D",
    "older-checkpoint-preservation": "\u4FDD\u7559\u65E7\u9875\u9762\u672A\u5904\u7406\u68C0\u67E5\u70B9",
    "draft-checkpoint-acl": "\u8349\u7A3F\u68C0\u67E5\u70B9\u6743\u9650\u9650\u5236",
    "profile-three-component-restore": "Profile \u4E09\u7EC4\u4EF6\u914D\u7F6E\u6062\u590D",
    "profile-target-protection": "Profile \u552F\u4E00\u76EE\u6807\u4E0E\u7BA1\u7406\u4FDD\u62A4",
    "profile-runtime-state-verification": "Profile \u6062\u590D\u5B9E\u9645\u8FD0\u884C\u72B6\u6001\u786E\u8BA4"
  };
  var sourceLabels = { configured: "\u56FA\u5B9A\u5165\u53E3", managed: "\u53D7\u7BA1\u5B89\u88C5", private: "\u79C1\u6709\u5B89\u88C5", global: "\u5168\u5C40\u5B89\u88C5" };
  var operationLabels = { restart: "\u91CD\u65B0\u542F\u52A8", update: "\u66F4\u65B0", restore: "\u6062\u590D", backup: "\u5907\u4EFD", rollback: "\u56DE\u9000", install: "\u5B89\u88C5" };
  var stageLabels = {
    preparing: "\u51C6\u5907\u4E2D",
    "waiting-idle": "\u7B49\u5F85\u7A7A\u95F2",
    capturing: "\u4FDD\u5B58\u754C\u9762\u72B6\u6001",
    checkpointing: "\u4FDD\u5B58\u68C0\u67E5\u70B9",
    "starting-candidate": "\u542F\u52A8\u4E2D",
    restoring: "\u6062\u590D\u754C\u9762\u72B6\u6001",
    committing: "\u63D0\u4EA4\u4E2D",
    "rolling-back": "\u56DE\u9000\u4E2D",
    "recovery-required": "\u9700\u8981\u6062\u590D"
  };
  var componentLabels = {
    sessions: "\u4F1A\u8BDD\u4E0E\u5DE5\u4F5C\u533A\u5F15\u7528",
    attachments: "\u9644\u4EF6",
    "upstream-settings": "\u4E0A\u6E38\u4E1A\u52A1\u8BBE\u7F6E",
    "desktop-preferences": "\u684C\u9762\u504F\u597D",
    "plugin-intent": "\u5185\u7F6E\u589E\u5F3A\u5F00\u5173",
    "profile-plugins": "Profile \u63D2\u4EF6\u5F00\u5173",
    changes: "\u66F4\u6539\u5FEB\u7167",
    "remote-preferences": "\u8FDC\u7A0B\u8BBF\u95EE\u914D\u7F6E",
    drafts: "\u8349\u7A3F\u4E0E\u672A\u4FDD\u5B58\u7F16\u8F91",
    credentials: "\u8BA4\u8BC1\u51ED\u636E"
  };
  var reasons = {
    "snapshot-terminal-cold-unavailable": "\u539F\u7EC8\u7AEF\u8FDB\u7A0B\u65E0\u6CD5\u8DE8\u5E94\u7528\u9000\u51FA\u6062\u590D\u3002\u8BF7\u4FDD\u7559\u7A0D\u540E\u5904\u7406\uFF0C\u6216\u5728\u6062\u590D\u8BB0\u5F55\u4E2D\u660E\u786E\u9009\u62E9\u8DF3\u8FC7\u7EC8\u7AEF\u72B6\u6001\u3002",
    "partial-config-backup-available": "\u652F\u6301\u90E8\u5206\u914D\u7F6E\u5907\u4EFD\u3001\u5F52\u6863\u6821\u9A8C\u4E0E\u540C\u7248\u672C\u504F\u597D\u6062\u590D\uFF1B\u5B8C\u6574\u6570\u636E\u6062\u590D\u4ECD\u5728\u5B9E\u65BD\u3002",
    "backup-restore-transaction-pending": "\u5F52\u6863\u5DF2\u6821\u9A8C\uFF1B\u5199\u5165\u5F53\u524D\u6570\u636E\u7684\u6062\u590D\u4E8B\u52A1\u4ECD\u5728\u5B9E\u65BD\u3002",
    "backup-restore-preview": "\u5C06\u5148\u4FDD\u5B58\u5F53\u524D\u914D\u7F6E\u4E0E\u754C\u9762\u72B6\u6001\uFF0C\u518D\u6062\u590D\u6240\u9009\u914D\u7F6E\uFF1B\u5931\u8D25\u65F6\u5C1D\u8BD5\u56DE\u9000\uFF0C\u51B2\u7A81\u65F6\u4FDD\u7559\u53CC\u65B9\u6750\u6599\u3002",
    "backup-restore-unavailable": "\u5F53\u524D\u53EA\u80FD\u6821\u9A8C\u6B64\u5907\u4EFD\uFF0C\u8BF7\u542F\u52A8\u5339\u914D\u7684 DSH \u540E\u91CD\u65B0\u9009\u62E9\u6587\u4EF6\u3002",
    "backup-restore-version": "\u5907\u4EFD\u4E0E\u5F53\u524D DSH \u7248\u672C\u4E0D\u540C\uFF0C\u6682\u4E0D\u652F\u6301\u8DE8\u7248\u672C\u914D\u7F6E\u6062\u590D\u3002",
    "backup-restore-binding": "\u5F53\u524D\u914D\u7F6E\u4F4D\u7F6E\u4E0E\u8FD0\u884C\u65F6\u89E3\u6790\u7ED3\u679C\u4E0D\u4E00\u81F4\uFF0C\u672A\u4FEE\u6539\u914D\u7F6E\u3002",
    "backup-component-unsupported": "\u6B64\u7EC4\u4EF6\u5C1A\u672A\u652F\u6301\u5B89\u5168\u6062\u590D\uFF0C\u4ECD\u53EF\u6821\u9A8C\u548C\u5BFC\u51FA\u3002",
    "backup-profile-unavailable": "\u5F53\u524D Profile \u7EC4\u6210\u65E0\u6CD5\u5B8C\u6574\u8BFB\u53D6\uFF0C\u672A\u5199\u5165\u63D2\u4EF6\u5F00\u5173\u3002",
    "backup-profile-schema": "Profile \u63D2\u4EF6\u5F00\u5173\u914D\u7F6E\u65E0\u6548\uFF0C\u672A\u5199\u5165\u5F53\u524D\u914D\u7F6E\u3002",
    "backup-profile-version": "Profile \u63D2\u4EF6\u5F00\u5173\u8BB0\u5F55\u4E0E\u5F53\u524D DSH \u7248\u672C\u4E0D\u5339\u914D\u3002",
    "backup-profile-target": "Profile \u5F00\u5173\u5305\u542B\u5DF2\u53D8\u66F4\u3001\u65E0\u6CD5\u552F\u4E00\u5B9A\u4F4D\u6216\u53D7\u4FDD\u62A4\u7684\u63D2\u4EF6\uFF0C\u672A\u5199\u5165\u5F53\u524D\u914D\u7F6E\u3002",
    "backup-profile-changed": "Profile \u63D2\u4EF6\u7EC4\u6210\u6216\u5F00\u5173\u5728\u9884\u89C8\u540E\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6821\u9A8C\u5907\u4EFD\u3002",
    "backup-profile-locked": "\u5176\u4ED6\u64CD\u4F5C\u6B63\u6301\u6709 Profile \u5199\u9501\uFF0C\u8BF7\u7A0D\u540E\u91CD\u65B0\u6821\u9A8C\u5907\u4EFD\u3002",
    "backup-profile-lock-lost": "Profile \u5199\u9501\u5DF2\u4E22\u5931\uFF0C\u6062\u590D\u6750\u6599\u4ECD\u4FDD\u7559\uFF0C\u8BF7\u67E5\u770B\u8BCA\u65AD\u3002",
    "backup-profile-verify": "Profile \u63D2\u4EF6\u672A\u8FBE\u5230\u6062\u590D\u540E\u7684\u8FD0\u884C\u72B6\u6001\uFF0C\u5C06\u5C1D\u8BD5\u56DE\u9000\u914D\u7F6E\u3002",
    "backup-preview-expired": "\u6062\u590D\u9884\u89C8\u5DF2\u8FC7\u671F\u6216\u9875\u9762\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9009\u62E9\u5907\u4EFD\u6587\u4EF6\u3002",
    "backup-target-changed": "\u914D\u7F6E\u5728\u9884\u89C8\u540E\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u6821\u9A8C\u5907\u4EFD\u6587\u4EF6\u3002",
    "backup-rollback-conflict": "\u56DE\u9000\u9047\u5230\u5916\u90E8\u7F16\u8F91\u51B2\u7A81\uFF0C\u5F53\u524D\u6587\u4EF6\u3001\u68C0\u67E5\u70B9\u4E0E\u6062\u590D\u5305\u5747\u5DF2\u4FDD\u7559\u3002",
    "backup-restore-failed": "\u914D\u7F6E\u6062\u590D\u672A\u5B8C\u6210\uFF0C\u8BF7\u67E5\u770B\u8BCA\u65AD\u4E0E\u6062\u590D\u8BB0\u5F55\u3002",
    "backup-checkpoint-capacity": "\u914D\u7F6E\u68C0\u67E5\u70B9\u7A7A\u95F4\u5DF2\u6EE1\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u914D\u7F6E\u3002",
    "backup-component-selection": "\u8BF7\u9009\u62E9\u53D7\u652F\u6301\u7684\u914D\u7F6E\u7EC4\u4EF6\u3002",
    "backup-password-invalid": "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u5907\u4EFD\u5BC6\u7801\u3002",
    "backup-password-required": "\u6B64\u5907\u4EFD\u5DF2\u52A0\u5BC6\uFF0C\u8BF7\u8F93\u5165\u5BC6\u7801\u540E\u91CD\u65B0\u9009\u62E9\u3002",
    "backup-authentication": "\u5BC6\u7801\u4E0D\u6B63\u786E\u6216\u5907\u4EFD\u5DF2\u635F\u574F\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "backup-kdf-parameters": "\u5907\u4EFD\u7684\u5BC6\u7801\u53C2\u6570\u4E0D\u53D7\u652F\u6301\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "backup-provider-empty": "\u6240\u9009\u8303\u56F4\u6CA1\u6709\u53EF\u5BFC\u51FA\u7684\u914D\u7F6E\u6587\u4EF6\u3002",
    "backup-provider-unavailable": "\u914D\u7F6E\u4F4D\u7F6E\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u7A0D\u540E\u5237\u65B0\u91CD\u8BD5\u3002",
    "backup-provider-failed": "\u914D\u7F6E\u5FEB\u7167\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6587\u4EF6\u540E\u91CD\u8BD5\u3002",
    "backup-provider-changed": "\u914D\u7F6E\u5728\u5FEB\u7167\u671F\u95F4\u53D1\u751F\u53D8\u5316\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    "backup-invalid": "\u5907\u4EFD\u683C\u5F0F\u6216\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "backup-export-failed": "\u5907\u4EFD\u5BFC\u51FA\u5931\u8D25\uFF0C\u539F\u914D\u7F6E\u4ECD\u4FDD\u7559\u3002",
    "backup-archive-entry": "\u5907\u4EFD\u5305\u542B\u4E0D\u652F\u6301\u7684\u8DEF\u5F84\u6216\u8D85\u989D\u6761\u76EE\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "backup-entry-integrity": "\u5907\u4EFD\u6761\u76EE\u6821\u9A8C\u5931\u8D25\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "backup-manifest-schema": "\u5907\u4EFD\u6E05\u5355\u7248\u672C\u6216\u683C\u5F0F\u4E0D\u53D7\u652F\u6301\uFF0C\u672A\u4FEE\u6539\u5F53\u524D\u6570\u636E\u3002",
    "recovery-binding": "\u6062\u590D\u5305\u5C5E\u4E8E\u5176\u4ED6\u6570\u636E\u6839\u6216 Profile\uFF0C\u672A\u5199\u5165\u5F53\u524D\u4F1A\u8BDD\u3002",
    "recovery-version": "\u5F53\u524D dsh \u7248\u672C\u4E0E\u6062\u590D\u5305\u4E0D\u5339\u914D\uFF0C\u8BF7\u4F7F\u7528\u5339\u914D\u7248\u672C\u3002",
    "recovery-backend-unavailable": "\u540E\u53F0\u672A\u5C31\u7EEA\uFF0C\u8BF7\u5148\u542F\u52A8\u5339\u914D\u7684 dsh \u518D\u6062\u590D\u3002",
    "recovery-storage-unavailable": "\u5B58\u50A8\u670D\u52A1\u5C1A\u672A\u786E\u8BA4\u6570\u636E\u6839\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
    "recovery-read-failed": "\u6062\u590D\u5305\u6821\u9A8C\u5931\u8D25\uFF0C\u539F\u6587\u4EF6\u4ECD\u4FDD\u7559\u3002",
    "recovery-save-failed": "\u6062\u590D\u5305\u4FDD\u5B58\u5931\u8D25\uFF0C\u539F\u9875\u9762\u548C\u670D\u52A1\u5DF2\u4FDD\u7559\u3002",
    "maintenance-journal-save-failed": "\u7EF4\u62A4\u8BB0\u5F55\u4FDD\u5B58\u5931\u8D25\uFF0C\u6062\u590D\u6750\u6599\u4ECD\u4FDD\u7559\u3002",
    "maintenance-interrupted": "\u7EF4\u62A4\u64CD\u4F5C\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u5904\u7406\u672A\u4FDD\u5B58\u5185\u5BB9\u6062\u590D\u5305\u3002",
    "ui-restore-failed": "\u754C\u9762\u6062\u590D\u5931\u8D25\uFF0C\u6062\u590D\u5305\u4ECD\u4FDD\u7559\u3002",
    "recovery-deferred": "\u5DF2\u4FDD\u7559\u6062\u590D\u5305\u4F9B\u7A0D\u540E\u5904\u7406\u3002",
    "application-exited": "\u5E94\u7528\u9000\u51FA\u65F6\u7EF4\u62A4\u5C1A\u672A\u5B8C\u6210\uFF0C\u6062\u590D\u5305\u4ECD\u4FDD\u7559\u3002",
    "legacy-update-failed": "\u66F4\u65B0\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u68C0\u6D4B\u5E76\u5904\u7406\u6062\u590D\u5305\u3002",
    "backend-restart-failed": "\u540E\u53F0\u91CD\u65B0\u542F\u52A8\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u8BCA\u65AD\u5E76\u5904\u7406\u6062\u590D\u5305\u3002",
    "provider-root-confirmed": "\u6D3B\u52A8\u5B58\u50A8\u670D\u52A1\u5DF2\u786E\u8BA4\u8BE5\u6570\u636E\u76EE\u5F55\uFF1B\u4E00\u81F4\u6027\u5FEB\u7167\u4ECD\u5F85\u9A8C\u8BC1\u3002",
    "structured-provider-confirmed": "\u5DF2\u786E\u8BA4\u7ED3\u6784\u5316\u504F\u597D\u6216\u63D2\u4EF6\u610F\u56FE\u4F4D\u7F6E\uFF1B\u5B8C\u6574\u5907\u4EFD\u4ECD\u5F85\u4E00\u81F4\u6027\u9A8C\u8BC1\u3002",
    "schema-secret-classification-partial": "\u53EF\u8BC6\u522B Schema \u6807\u6CE8\u7684\u51ED\u636E\uFF1B\u672A\u6807\u6CE8\u7684\u7B2C\u4E09\u65B9\u914D\u7F6E\u4ECD\u9700\u9002\u914D\u3002",
    "feature-provider-unreported": "\u5C1A\u672A\u6536\u5230\u8BE5\u529F\u80FD\u7684\u80FD\u529B\u62A5\u544A\u3002",
    "storage-adapter-unverified": "\u5B58\u50A8\u6620\u5C04\u5C1A\u672A\u9A8C\u8BC1\uFF0C\u5B8C\u6574\u5907\u4EFD\u6682\u4E0D\u53EF\u7528\u3002",
    "storage-consistency-unverified": "\u6570\u636E\u4E00\u81F4\u6027\u63A5\u53E3\u5C1A\u672A\u9A8C\u8BC1\u3002",
    "runtime-snapshot-unverified": "\u65E7\u8FD0\u884C\u65F6\u7684\u79BB\u7EBF\u5FEB\u7167\u5C1A\u672A\u9A8C\u8BC1\u3002",
    "runtime-migration-scope-unverified": "\u6570\u636E\u8FC1\u79FB\u8303\u56F4\u5C1A\u672A\u9A8C\u8BC1\uFF0C\u53EF\u9760\u56DE\u9000\u6682\u4E0D\u53EF\u7528\u3002",
    "runtime-explicitly-pinned": "\u5F53\u524D\u5165\u53E3\u7531 DSH_DESKTOP_DSH \u56FA\u5B9A\u3002",
    "node-supported": "Node \u7248\u672C\u7B26\u5408\u8981\u6C42\u3002",
    "node-missing": "\u672A\u627E\u5230 Node.js\u3002",
    "node-version-unsupported": "Node \u7248\u672C\u4E0D\u7B26\u5408\u8981\u6C42\u6216\u68C0\u67E5\u8D85\u65F6\u3002",
    "npm-probed": "npm \u68C0\u67E5\u901A\u8FC7\u3002",
    "npm-unavailable": "npm \u4E0D\u53EF\u7528\u6216\u68C0\u67E5\u8D85\u65F6\u3002",
    "runtime-entry-found": "\u5DF2\u627E\u5230\u5B9E\u9645\u8FD0\u884C\u5165\u53E3\u3002",
    "runtime-entry-missing": "\u672A\u627E\u5230 dsh \u5165\u53E3\u3002",
    "roots-resolved-consistency-unverified": "\u5DF2\u89E3\u6790\u6570\u636E\u6839\uFF1B\u4E00\u81F4\u6027\u4E0E\u5907\u4EFD\u8303\u56F4\u5F85\u9A8C\u8BC1\u3002",
    "inventory-resolver-unavailable": "\u8BE5\u8FD0\u884C\u65F6\u6CA1\u6709\u53EF\u9A8C\u8BC1\u7684\u53EA\u8BFB\u76EE\u5F55\u89E3\u6790\u63A5\u53E3\u3002",
    "webview-version-reported": "\u5DF2\u8BFB\u53D6 WebView2 \u7248\u672C\u3002",
    "webview-version-unavailable": "\u672A\u80FD\u8BFB\u53D6 WebView2 \u7248\u672C\u3002",
    "terminal-processes-not-restored": "\u7EC8\u7AEF\u6807\u7B7E\u53EF\u6062\u590D\uFF1B\u7EC8\u7AEF\u8FDB\u7A0B\u548C\u547D\u4EE4\u4E0D\u4F1A\u6062\u590D\u3002",
    "profile-management-unavailable": "\u5F53\u524D\u7248\u672C\u7684 profile \u63D2\u4EF6\u7BA1\u7406\u4E0D\u53EF\u7528\u3002",
    "optional-plugin-load-failed": "\u53EF\u9009\u63D2\u4EF6\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u63D2\u4EF6\u72B6\u6001\u3002",
    "capability-report-expired": "\u8BE5\u529F\u80FD\u7684\u80FD\u529B\u62A5\u544A\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u68C0\u6D4B\u3002",
    "capability-document-changed": "\u9875\u9762\u5DF2\u53D8\u5316\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u9875\u9762\u91CD\u65B0\u62A5\u544A\u80FD\u529B\u3002",
    "remote-configuration-applying": "\u6B63\u5728\u5E94\u7528\u8FDC\u7A0B\u914D\u7F6E\u3002",
    "remote-backend-unavailable": "\u540E\u53F0\u672A\u5C31\u7EEA\uFF0C\u6682\u4E0D\u80FD\u4F7F\u7528\u5C40\u57DF\u7F51\u8BBF\u95EE\u3002",
    "remote-local-fallback": "\u8FDC\u7A0B\u914D\u7F6E\u9047\u5230\u95EE\u9898\uFF1B\u8BF7\u67E5\u770B\u8FDC\u7A0B\u63A7\u5236\u8BBE\u7F6E\uFF0C\u73B0\u6709\u914D\u7F6E\u610F\u56FE\u4ECD\u4FDD\u7559\u3002",
    "remote-access-user-disabled": "\u8FDC\u7A0B\u8BBF\u95EE\u5DF2\u7531\u7528\u6237\u5173\u95ED\uFF1B\u68C0\u67E5\u4E0D\u4F1A\u542F\u7528\u76D1\u542C\u3002",
    "remote-client-reachability-unverified": "\u76D1\u542C\u5DF2\u542F\u52A8\uFF1B\u624B\u673A\u53EF\u8FBE\u6027\u548C\u7F51\u7EDC\u73AF\u5883\u9700\u5728\u5BF9\u5E94\u8BBE\u5907\u9A8C\u8BC1\u3002",
    "remote-listener-unconfirmed": "\u5C1A\u672A\u786E\u8BA4\u5F53\u524D\u8FDC\u7A0B\u76D1\u542C\uFF0C\u8BF7\u67E5\u770B\u8FDC\u7A0B\u63A7\u5236\u72B6\u6001\u3002",
    "capability-selector-failed": "\u529F\u80FD\u63A5\u53E3\u68C0\u67E5\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u5E76\u67E5\u770B\u63D2\u4EF6\u72B6\u6001\u3002",
    "file-editor-contract-unavailable": "\u5F53\u524D\u7248\u672C\u7F3A\u5C11\u5B89\u5168\u6587\u4EF6\u7F16\u8F91\u6240\u9700\u7684\u670D\u52A1\u6216\u5173\u95ED\u786E\u8BA4\u63A5\u53E3\u3002",
    "file-editor-text-resource-limits": "\u652F\u6301\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u7684\u6587\u672C\u6587\u4EF6\uFF1B\u5927\u6587\u4EF6\u3001\u4E8C\u8FDB\u5236\u53CA\u7B26\u53F7\u94FE\u63A5\u53D7\u9650\u5236\u3002",
    "changes-contract-unavailable": "\u5F53\u524D\u7248\u672C\u7F3A\u5C11\u66F4\u6539\u4E0E Git \u6240\u9700\u7684\u6267\u884C\u670D\u52A1\u63A5\u53E3\u3002",
    "changes-no-current-session": "\u8BF7\u5148\u6253\u5F00\u4F1A\u8BDD\uFF1BGit \u68C0\u6D4B\u53EA\u9002\u7528\u4E8E\u5F53\u524D\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u3002",
    "changes-session-ambiguous": "\u65E0\u6CD5\u552F\u4E00\u786E\u5B9A\u5F53\u524D\u4F1A\u8BDD\uFF0C\u672A\u6CBF\u7528\u5176\u4ED6\u5DE5\u4F5C\u533A\u7684\u7ED3\u679C\u3002",
    "changes-query-interrupted": "\u5DE5\u4F5C\u533A\u68C0\u67E5\u88AB\u4E2D\u65AD\uFF0C\u8BF7\u91CD\u65B0\u68C0\u6D4B\u3002",
    "changes-query-failed": "\u5F53\u524D\u5DE5\u4F5C\u533A\u67E5\u8BE2\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u68C0\u6D4B\u3002",
    "changes-response-unrecognized": "\u5F53\u524D\u7248\u672C\u7684\u5DE5\u4F5C\u533A\u80FD\u529B\u54CD\u5E94\u5C1A\u672A\u9002\u914D\u3002",
    "changes-recording-coverage-limited": "\u652F\u6301\u5F53\u524D\u5DE5\u4F5C\u533A\u7684\u66F4\u6539\u4E0E Git\uFF1B\u91C7\u96C6\u9884\u7B97\u548C\u672A\u53D7\u7BA1\u8FDB\u7A0B\u53EF\u80FD\u9020\u6210\u8BB0\u5F55\u7F3A\u53E3\u3002",
    "changes-workspace-not-git": "\u5F53\u524D\u5DE5\u4F5C\u533A\u4E0D\u5728 Git \u4ED3\u5E93\u4E2D\uFF1B\u4F1A\u8BDD\u66F4\u6539\u8BB0\u5F55\u4ECD\u53EF\u4F7F\u7528\u3002",
    "changes-git-missing": "\u6267\u884C\u7AEF\u672A\u627E\u5230 Git\uFF1B\u4F1A\u8BDD\u66F4\u6539\u8BB0\u5F55\u4ECD\u53EF\u4F7F\u7528\u3002",
    "changes-git-unavailable": "\u5F53\u524D Git \u4ED3\u5E93\u8BFB\u53D6\u5931\u8D25\uFF1B\u4F1A\u8BDD\u66F4\u6539\u8BB0\u5F55\u4ECD\u53EF\u4F7F\u7528\u3002",
    "session-link-target-preflight": "\u652F\u6301\u672C\u5730\u4F1A\u8BDD\u5F15\u7528\uFF1B\u6253\u5F00\u65F6\u4ECD\u68C0\u67E5\u76EE\u6807\u4F1A\u8BDD\u662F\u5426\u5B58\u5728\u3002",
    "session-links-contract-unavailable": "\u5F53\u524D\u9875\u9762\u7F3A\u5C11\u4F1A\u8BDD\u5F15\u7528\u6240\u9700\u7684\u5BFC\u822A\u6216\u6D88\u606F\u63A5\u53E3\u3002",
    "session-export-completion-preflight": "\u652F\u6301\u4F1A\u8BDD\u5BFC\u51FA\u5E76\u7B49\u5F85\u6587\u4EF6\u4FDD\u5B58\u5B8C\u6210\uFF1B\u5B9E\u9645\u5BFC\u51FA\u4ECD\u68C0\u67E5\u6743\u9650\u4E0E\u4E0B\u8F7D\u7ED3\u679C\u3002",
    "session-export-contract-unavailable": "\u5F53\u524D\u9875\u9762\u7F3A\u5C11\u684C\u9762\u4F1A\u8BDD\u5BFC\u51FA\u6240\u9700\u7684\u4E0B\u8F7D\u6216\u539F\u751F\u63A5\u53E3\u3002",
    "notification-transport-unreported": "\u5C1A\u672A\u6536\u5230\u539F\u751F\u901A\u77E5\u670D\u52A1\u7684\u521D\u59CB\u5316\u7ED3\u679C\u3002",
    "notification-service-unavailable": "\u539F\u751F\u901A\u77E5\u670D\u52A1\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u8BCA\u65AD\u8BB0\u5F55\u3002",
    "notification-registration-unavailable": "\u901A\u77E5\u8EAB\u4EFD\u6CE8\u518C\u5931\u8D25\uFF1B\u539F\u751F\u670D\u52A1\u5DF2\u542F\u52A8\uFF0C\u901A\u77E5\u6FC0\u6D3B\u4ECD\u53D7\u9650\u5236\u3002",
    "notification-delivery-failed": "\u6700\u8FD1\u4E00\u6B21\u901A\u77E5\u63D0\u4EA4\u6216\u9001\u8FBE\u5931\u8D25\uFF1B\u8BF7\u68C0\u67E5 Windows \u901A\u77E5\u8BBE\u7F6E\u3002",
    "notification-display-preflight-required": "\u539F\u751F\u901A\u77E5\u670D\u52A1\u5DF2\u521D\u59CB\u5316\uFF1B\u5B9E\u9645\u663E\u793A\u4ECD\u53D6\u51B3\u4E8E Windows \u901A\u77E5\u8BBE\u7F6E\u4E0E\u52FF\u6270\u6A21\u5F0F\u3002",
    "recovery-background-checkpoints-pending": "\u7EF4\u62A4\u91CD\u542F\u65F6\u4FDD\u5B58\u8349\u7A3F\u548C\u9644\u4EF6\uFF1B\u65E5\u5E38\u540E\u53F0\u68C0\u67E5\u70B9\u5C1A\u672A\u5B9E\u73B0\u3002",
    "recovery-background-checkpoint-limits": "\u540E\u53F0\u4FDD\u5B58\u7A33\u5B9A\u7684\u8BED\u4E49\u8349\u7A3F\u548C\u9644\u4EF6\uFF1B\u4E0D\u5305\u542B\u6587\u4EF6\u7F16\u8F91\u7F13\u51B2\u4E0E\u7EC8\u7AEF\uFF0C\u6700\u540E\u4E00\u4E2A\u68C0\u67E5\u70B9\u540E\u7684\u8F93\u5165\u53EF\u80FD\u65E0\u6CD5\u6062\u590D\u3002",
    "ui-recovery-state-preflight-required": "\u6B64\u9879\u68C0\u67E5\u670D\u52A1\u63A5\u53E3\uFF1B\u5B9E\u9645\u6062\u590D\u4ECD\u4F1A\u68C0\u67E5\u8F93\u5165\u3001\u9644\u4EF6\u548C\u9762\u677F\u72B6\u6001\u3002",
    "snapshot-adapter-unsupported": "\u5F53\u524D\u7248\u672C\u7F3A\u5C11\u5B89\u5168\u754C\u9762\u6062\u590D\u6240\u9700\u7684\u670D\u52A1\u63A5\u53E3\u3002",
    "snapshot-layout-unsupported": "\u5F53\u524D\u5E03\u5C40\u63A5\u53E3\u4E0D\u652F\u6301\u5B89\u5168\u4FDD\u5B58\u548C\u6062\u590D\u3002",
    "snapshot-navigation-unsupported": "\u5F53\u524D\u7248\u672C\u53EA\u80FD\u5728\u5DF2\u6253\u5F00\u4F1A\u8BDD\u65F6\u4FDD\u5B58\u754C\u9762\u3002",
    "maintenance-busy": "\u53E6\u4E00\u9879\u7EF4\u62A4\u64CD\u4F5C\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
    "diagnostics-check-busy": "\u8BCA\u65AD\u68C0\u67E5\u6B63\u5728\u6267\u884C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002"
  };
  function createReportStore(invoke, identity, now = Date.now) {
    let snapshot = { report: null, busy: false, error: null, exported: null }, pending, disposed = false;
    const listeners = /* @__PURE__ */ new Set();
    const publish = (next) => {
      if (disposed) return;
      snapshot = { ...snapshot, ...next };
      listeners.forEach((fn) => fn());
    };
    const run = (command) => {
      if (pending) return pending;
      const claimed = identity();
      publish({ busy: true, error: null, exported: null });
      pending = Promise.resolve().then(() => invoke(command, { identity: claimed })).then((result) => {
        if (claimed?.backendInstance !== identity()?.backendInstance) return;
        if (command === "desktop_diagnostics_export") publish({ exported: result });
        else if (isCurrent(result, identity(), now())) publish({ report: result });
        else publish({ report: null, error: "\u8BCA\u65AD\u62A5\u544A\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u68C0\u6D4B\u3002" });
      }).catch((error) => {
        if (claimed?.backendInstance === identity()?.backendInstance) publish({ error: typeof error === "string" ? error : error?.message || "\u8BCA\u65AD\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002" });
      }).finally(() => {
        pending = null;
        publish({ busy: false });
      });
      return pending;
    };
    return {
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      getSnapshot: () => snapshot,
      refresh: () => run("desktop_diagnostics"),
      check: () => run("desktop_diagnostics_check"),
      export: () => run("desktop_diagnostics_export"),
      dispose() {
        disposed = true;
        listeners.clear();
      }
    };
  }

  // dsh-plugin/desktop-maintenance/style.css
  var style_default = ".dshMaintenance{width:100%;max-width:760px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}\n.dshMaintenance__dialog[role=dialog]{width:min(800px,100%);max-height:100%}\n.dshMaintenance__content{min-height:0;display:flex;flex-direction:column;overflow:hidden}\n.dshMaintenance__content>:first-child{flex:none}\n.dshMaintenance__content>:last-child{min-height:0;overflow:auto;overscroll-behavior:contain}\n.dshMaintenance p,.dshMaintenance h3{margin:0}.dshMaintenance h3{font-size:15px;font-weight:600}\n.dshMaintenance__actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n.dshMaintenance__stack,.dshMaintenance__tools{display:flex;flex-direction:column;gap:12px}\n.dshMaintenance__card{padding:16px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill);min-width:0;overflow-wrap:anywhere}\n.dshMaintenance__row{display:flex;gap:16px;align-items:baseline;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--dsw-alias-settings-card-stroke)}\n.dshMaintenance__row:last-child{border-bottom:0}.dshMaintenance__row dd{margin:0;max-width:70%;text-align:right;overflow-wrap:anywhere}.dshMaintenance dl{margin:0}\n.dshMaintenance__note{color:var(--dsw-alias-label-secondary)}.dshMaintenance__error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}\n.dshMaintenance__choices{display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0;padding:8px 0;border:0}.dshMaintenance__choices label,.dshMaintenance__choice{display:flex;align-items:center;gap:8px;min-height:44px}.dshMaintenance__password{display:flex;flex-direction:column;gap:4px;margin:8px 0}.dshMaintenance__password input{background:var(--dsw-alias-settings-card-fill);color:inherit;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:8px;padding:8px;min-height:28px}\n.dshMaintenance__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}\n.dshMaintenance button{min-height:44px;cursor:pointer}.dshMaintenance button:disabled{cursor:default}.dshMaintenance button:focus-visible,.dshMaintenance summary:focus-visible{outline:2px solid var(--dsw-alias-state-info-primary,#4678e7);outline-offset:3px}\n.dshMaintenance code{font-size:12px;overflow-wrap:anywhere}.dshMaintenance details{margin-top:8px}.dshMaintenance summary{cursor:pointer;padding:8px 0;min-height:28px}\n.dshMaintenance__disclosure>summary{font-weight:600}.dshMaintenance__disclosure[open]>summary{margin-bottom:8px}\n@media(max-width:480px){.dshMaintenance{font-size:16px}.dshMaintenance__row{flex-direction:column;gap:4px}.dshMaintenance__row dd{max-width:100%;text-align:left}}\n";

  // dsh-plugin/desktop-maintenance/client-entry.mjs
  window.__ModuleLoader__.load({ id: "@dsh-desktop/maintenance", factory(require2) {
    const React = require2("react"), h = React.createElement;
    const { Button, Modal } = require2("@deepseek-ai/dsh-client-ui-primitives");
    function apply(ctx) {
      const desktop = window.top === window && typeof window.__TAURI__?.core?.invoke === "function";
      const store = desktop ? createReportStore((cmd, args) => window.__TAURI__.core.invoke(cmd, args), () => window.__DSH_REMOTE_IDENTITY__) : null;
      const style = document.createElement("style");
      style.textContent = style_default;
      document.head.appendChild(style);
      const row = (label, value) => h("div", { className: "dshMaintenance__row", key: label }, h("dt", null, t(label)), h("dd", null, value ?? t("\u672A\u77E5")));
      const reason = (code) => t(reasons[code] || code);
      function BackupTools() {
        const [selected, setSelected] = React.useState(["desktop-preferences", "plugin-intent", "profile-plugins"]);
        const [encrypted, setEncrypted] = React.useState(false), [password, setPassword] = React.useState("");
        const [state, setState] = React.useState({ busy: false, error: null, path: null, preview: null, cancelled: false });
        const [restoreSelected, setRestoreSelected] = React.useState([]), [confirmed, setConfirmed] = React.useState(false);
        const run = async (command) => {
          setConfirmed(false);
          setRestoreSelected([]);
          setState({ busy: true, error: null, path: null, preview: null, cancelled: false });
          try {
            const result = await window.__TAURI__.core.invoke(command, {
              identity: window.__DSH_REMOTE_IDENTITY__,
              ...command === "desktop_backup_export" ? { components: selected } : {},
              password: encrypted ? password : null
            });
            setState({
              busy: false,
              error: null,
              path: command === "desktop_backup_export" ? result : null,
              preview: command === "desktop_backup_inspect" ? result : null,
              cancelled: result === null
            });
            if (command === "desktop_backup_inspect") setRestoreSelected(result?.supportedComponents ?? []);
          } catch (error) {
            setState({ busy: false, error: String(error?.message ?? error), path: null, preview: null, cancelled: false });
          } finally {
            setPassword("");
          }
        };
        const restore = async () => {
          const bridge = window.__DSH_UI_STATE__, identity = window.__DSH_REMOTE_IDENTITY__;
          setState((value) => ({ ...value, busy: true, error: null }));
          try {
            if (!bridge?.prepareRemoteApply) throw Error(t("\u9875\u9762\u4FDD\u5B58\u670D\u52A1\u5C1A\u672A\u51C6\u5907\u597D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
            const payload = await bridge.prepareRemoteApply(state.preview.manifest.dshVersion, t("\u6B63\u5728\u4FDD\u5B58\u5F53\u524D\u754C\u9762\u5E76\u6062\u590D\u914D\u7F6E\u2026"), { configurationRestore: true });
            await window.__TAURI__.core.invoke("desktop_backup_restore", { identity, restoreHandle: state.preview.restoreHandle, components: restoreSelected, payload });
          } catch (error) {
            bridge?.finishRemoteApply();
            setState((value) => ({ ...value, busy: false, error: String(error?.message ?? error) }));
          }
        };
        const preview = state.preview?.manifest;
        return h(
          "div",
          { className: "dshMaintenance__card dshMaintenance__tools", "aria-busy": state.busy, "data-dsh-configuration-restore": state.preview?.canRestore ? "" : void 0 },
          h("h3", null, t("\u914D\u7F6E\u5907\u4EFD\u4E0E\u6062\u590D")),
          h("p", { className: "dshMaintenance__note" }, t("\u5907\u4EFD\u684C\u9762\u504F\u597D\u548C\u63D2\u4EF6\u5F00\u5173\uFF0C\u53EF\u6062\u590D\u5230\u76F8\u540C\u7248\u672C\u7684 dsh\u3002")),
          h("p", { className: "dshMaintenance__note" }, t("\u6B64\u5907\u4EFD\u4E0D\u5305\u542B\u4F1A\u8BDD\u3001\u9644\u4EF6\u3001\u8349\u7A3F\u3001\u4E1A\u52A1\u914D\u7F6E\u6216\u51ED\u636E\u3002")),
          h(
            "fieldset",
            { disabled: state.busy, className: "dshMaintenance__choices" },
            h("legend", null, t("\u5BFC\u51FA\u8303\u56F4")),
            ["desktop-preferences", "plugin-intent", "profile-plugins"].map((id) => h(
              "label",
              { key: id },
              h("input", { type: "checkbox", checked: selected.includes(id), onChange: (event) => setSelected((value) => event.target.checked ? [...value, id] : value.filter((item) => item !== id)) }),
              t(componentLabels[id])
            ))
          ),
          h("label", { className: "dshMaintenance__choice" }, h("input", { type: "checkbox", checked: encrypted, disabled: state.busy, onChange: (event) => {
            setEncrypted(event.target.checked);
            setPassword("");
          } }), t("\u4F7F\u7528\u5BC6\u7801\u52A0\u5BC6\u6216\u6253\u5F00\u52A0\u5BC6\u5907\u4EFD")),
          encrypted && h("label", { className: "dshMaintenance__password" }, t("\u5907\u4EFD\u5BC6\u7801"), h("input", { type: "password", autoComplete: "new-password", value: password, maxLength: 256, disabled: state.busy, onChange: (event) => setPassword(event.target.value) })),
          h(
            "div",
            { className: "dshMaintenance__actions" },
            h(Button, { disabled: state.busy || !selected.length || encrypted && !password, onClick: () => run("desktop_backup_export") }, t("\u5BFC\u51FA\u90E8\u5206\u5907\u4EFD")),
            h(Button, { disabled: state.busy || encrypted && !password, onClick: () => run("desktop_backup_inspect") }, t("\u6821\u9A8C\u5907\u4EFD\u6587\u4EF6"))
          ),
          state.busy && h("p", { role: "status" }, t("\u6B63\u5728\u5904\u7406\u5907\u4EFD\u2026")),
          state.cancelled && h("p", { role: "status" }, t("\u5DF2\u53D6\u6D88")),
          state.error && h("p", { role: "alert" }, reason(state.error)),
          state.path && h("p", { role: "status" }, t("\u5907\u4EFD\u5DF2\u4FDD\u5B58\uFF1A{path}", { path: state.path })),
          preview && h(
            "div",
            null,
            h("p", { role: "status" }, t("\u5907\u4EFD\u6821\u9A8C\u901A\u8FC7")),
            h("p", null, new Date(preview.createdAt).toLocaleString() + " \xB7 dsh " + preview.dshVersion + " \xB7 " + t(preview.scope === "partial" ? "\u90E8\u5206\u5907\u4EFD" : "\u5B8C\u6574\u5907\u4EFD")),
            h("p", null, t("\u5305\u542B\uFF1A{items}", { items: preview.components.map((item) => t(componentLabels[item.id] || item.id)).join("\u3001") })),
            h("p", { className: "dshMaintenance__note" }, t("\u6392\u9664\uFF1A{items}", { items: preview.excluded.map((item) => t(componentLabels[item] || item)).join("\u3001") })),
            h("p", null, reason(state.preview.reasonCode)),
            state.preview.unsupportedComponents.length > 0 && h("p", { className: "dshMaintenance__note" }, t("\u6682\u4E0D\u6062\u590D\uFF1A{items}", { items: state.preview.unsupportedComponents.map((id) => t(componentLabels[id] || id)).join("\u3001") })),
            state.preview.canRestore && h(
              React.Fragment,
              null,
              h(
                "fieldset",
                { disabled: state.busy, className: "dshMaintenance__choices" },
                h("legend", null, t("\u6062\u590D\u8303\u56F4")),
                state.preview.supportedComponents.map((id) => h("label", { key: id }, h("input", { type: "checkbox", checked: restoreSelected.includes(id), onChange: (event) => {
                  setConfirmed(false);
                  setRestoreSelected((value) => event.target.checked ? [...value, id] : value.filter((item) => item !== id));
                } }), t(componentLabels[id])))
              ),
              h("label", { className: "dshMaintenance__choice" }, h("input", { type: "checkbox", checked: confirmed, disabled: state.busy, onChange: (event) => setConfirmed(event.target.checked) }), t("\u6211\u5DF2\u6838\u5BF9\u8303\u56F4\uFF0C\u6062\u590D\u5C06\u66FF\u6362\u6240\u9009\u504F\u597D\u6216\u5F00\u5173\u5E76\u91CD\u542F DSH\u3002")),
              h(Button, { disabled: state.busy || !confirmed || !restoreSelected.length, onClick: restore }, t("\u6062\u590D\u6240\u9009\u914D\u7F6E"))
            )
          ),
          h(
            "details",
            { className: "dshMaintenance__disclosure" },
            h("summary", null, t("\u6062\u590D\u8BF4\u660E")),
            h("p", { className: "dshMaintenance__note" }, t("\u53EF\u5BFC\u51FA\u5E76\u6062\u590D\u540C\u7248\u672C\u7684\u684C\u9762\u504F\u597D\u548C\u63D2\u4EF6\u5F00\u5173\u3002Profile \u5F00\u5173\u6062\u590D\u987B\u5339\u914D\u5F53\u524D\u552F\u4E00\u63D2\u4EF6\u53CA\u4FDD\u62A4\u89C4\u5219\uFF1B\u4E0D\u4F1A\u5B89\u88C5\u63D2\u4EF6\u3002\u4F1A\u8BDD\u3001\u9644\u4EF6\u3001\u8349\u7A3F\u53CA\u4E1A\u52A1\u914D\u7F6E\u4E0D\u5728\u6B64\u5907\u4EFD\u4E2D\u3002"))
          )
        );
      }
      function RecoveryPackages() {
        const [state, setState] = React.useState({ entries: [], unreadable: 0, busy: false, error: null });
        const refresh = async () => {
          setState((value) => ({ ...value, busy: true, error: null }));
          try {
            const identity = window.__DSH_REMOTE_IDENTITY__;
            const result = await window.__TAURI__.core.invoke("desktop_recovery_list", { identity });
            if (identity?.backendInstance !== window.__DSH_REMOTE_IDENTITY__?.backendInstance) return;
            setState({ ...result, busy: false, error: null });
          } catch (error) {
            setState((value) => ({ ...value, busy: false, error: String(error?.message ?? error) }));
          }
        };
        React.useEffect(() => {
          void refresh();
        }, []);
        const restore = async (recoveryId, skipTerminalState = false) => {
          setState((value) => ({ ...value, busy: true, error: null }));
          try {
            await window.__TAURI__.core.invoke("desktop_recovery_restore", { identity: window.__DSH_REMOTE_IDENTITY__, recoveryId, skipTerminalState });
          } catch (error) {
            setState((value) => ({ ...value, error: String(error?.message ?? error) }));
          } finally {
            setState((value) => ({ ...value, busy: false }));
          }
        };
        return h(
          "div",
          { className: "dshMaintenance__card dshMaintenance__tools", "aria-busy": state.busy },
          h("h3", null, t("\u672A\u4FDD\u5B58\u5185\u5BB9\u6062\u590D")),
          h("p", { className: "dshMaintenance__note" }, t("\u627E\u56DE\u610F\u5916\u9000\u51FA\u6216\u91CD\u542F\u524D\u4FDD\u5B58\u7684\u8349\u7A3F\u3001\u9644\u4EF6\u53CA\u652F\u6301\u7684\u672A\u4FDD\u5B58\u6587\u4EF6\u7F16\u8F91\u3002")),
          h("div", { className: "dshMaintenance__actions" }, h(Button, { onClick: refresh, disabled: state.busy }, t("\u5237\u65B0\u6062\u590D\u8BB0\u5F55"))),
          state.busy && h("p", { role: "status" }, t("\u6B63\u5728\u5904\u7406\u6062\u590D\u8BB0\u5F55\u2026")),
          state.error && h("p", { role: "alert" }, reason(state.error)),
          state.unreadable > 0 && h("p", { role: "alert" }, t("\u90E8\u5206\u6062\u590D\u5305\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u539F\u6587\u4EF6\u4ECD\u4FDD\u7559\u3002")),
          !state.busy && state.entries.length === 0 && h("p", null, t("\u6CA1\u6709\u5F85\u5904\u7406\u7684\u6062\u590D\u5305\u3002")),
          state.entries.map((entry) => h(
            "div",
            { key: entry.recoveryId, className: "dshMaintenance__card dshMaintenance__tools", "data-dsh-recovery-id": entry.recoveryId },
            h("p", null, new Date(entry.createdAt).toLocaleString()),
            h("p", null, t("\u8349\u7A3F\uFF1A{count}", { count: entry.draftCount })),
            entry.draftsOnly && h("p", { className: "dshMaintenance__note" }, t("\u65E5\u5E38\u8349\u7A3F\u68C0\u67E5\u70B9\uFF1B\u6062\u590D\u4FDD\u7559\u5F53\u524D\u9875\u9762\u9009\u62E9\u4E0E\u5E03\u5C40\u3002")),
            entry.hasTerminalState && h("p", { className: "dshMaintenance__note" }, t("\u539F\u7EC8\u7AEF\u8FDB\u7A0B\u65E0\u6CD5\u8DE8\u5E94\u7528\u9000\u51FA\u6062\u590D\u3002\u53EF\u8DF3\u8FC7\u7EC8\u7AEF\u72B6\u6001\u6062\u590D\u5176\u4F59\u5185\u5BB9\uFF1B\u4E0D\u4F1A\u65B0\u5EFA Shell \u6216\u91CD\u653E\u547D\u4EE4\uFF0C\u539F\u5305\u7EE7\u7EED\u4FDD\u7559\u3002")),
            entry.reasonCode && h("p", null, reason(entry.reasonCode)),
            entry.hasTerminalState ? h(Button, { disabled: state.busy || !entry.canRestore, onClick: () => restore(entry.recoveryId, true) }, t("\u8DF3\u8FC7\u7EC8\u7AEF\u72B6\u6001\uFF0C\u6062\u590D\u5176\u4F59\u5185\u5BB9")) : h(Button, { disabled: state.busy || !entry.canRestore, onClick: () => restore(entry.recoveryId) }, t("\u6062\u590D\u672A\u4FDD\u5B58\u5185\u5BB9")),
            h(
              "details",
              { className: "dshMaintenance__disclosure" },
              h("summary", null, t("\u6062\u590D\u8BB0\u5F55\u8BE6\u60C5")),
              h("p", null, "dsh " + entry.runtimeVersion),
              h("p", { className: "dshMaintenance__note" }, t("\u72B6\u6001\u63D0\u4F9B\u5668\uFF1A{count}", { count: entry.providerCount }))
            )
          )),
          h(
            "details",
            { className: "dshMaintenance__disclosure" },
            h("summary", null, t("\u4FDD\u5B58\u4E0E\u6062\u590D\u8BF4\u660E")),
            h(
              "div",
              { className: "dshMaintenance__stack" },
              h("p", { className: "dshMaintenance__note" }, t("\u6062\u590D\u5305\u4FDD\u7559\u8349\u7A3F\u3001\u9644\u4EF6\u548C\u652F\u6301\u7684\u7F16\u8F91\u7F13\u51B2\uFF1B\u6062\u590D\u524D\u68C0\u67E5\u5F53\u524D\u4F1A\u8BDD\u548C\u6587\u4EF6\uFF0C\u5931\u8D25\u65F6\u4FDD\u7559\u526F\u672C\u3002")),
              h("p", { className: "dshMaintenance__note" }, t("\u65E5\u5E38\u68C0\u67E5\u70B9\u4FDD\u5B58\u7A33\u5B9A\u7684\u8349\u7A3F\u548C\u9644\u4EF6\uFF0C\u6BCF\u6B21\u5199\u5165\u81F3\u5C11\u95F4\u9694 30 \u79D2\uFF1B\u6587\u4EF6\u7F16\u8F91\u4E0E\u7EC8\u7AEF\u4EC5\u6309\u7EF4\u62A4\u6062\u590D\u7B56\u7565\u5904\u7406\u3002")),
              h("p", { className: "dshMaintenance__note" }, t("\u540E\u53F0\u4FDD\u5B58\u7A33\u5B9A\u7684\u8BED\u4E49\u8349\u7A3F\u548C\u9644\u4EF6\uFF1B\u4E0D\u5305\u542B\u6587\u4EF6\u7F16\u8F91\u7F13\u51B2\u4E0E\u7EC8\u7AEF\uFF0C\u6700\u540E\u4E00\u4E2A\u68C0\u67E5\u70B9\u540E\u7684\u8F93\u5165\u53EF\u80FD\u65E0\u6CD5\u6062\u590D\u3002"))
            )
          )
        );
      }
      function FeatureStatus({ report }) {
        return h(
          "details",
          { className: "dshMaintenance__card dshMaintenance__disclosure", "data-dsh-feature-status": "" },
          h("summary", null, t("\u529F\u80FD\u72B6\u6001")),
          h(
            "div",
            { className: "dshMaintenance__stack" },
            h("p", { className: "dshMaintenance__note" }, t("\u68C0\u6D4B\u7ED3\u679C\u4E0E\u5B9E\u673A\u9A8C\u8BC1\u5206\u522B\u663E\u793A\u3002\u672A\u77E5\u72B6\u6001\u8868\u793A\u5C1A\u65E0\u53EF\u9760\u8BC1\u636E\u3002")),
            report.capabilities.map((feature) => h(
              "div",
              { key: feature.featureId, className: "dshMaintenance__card", "data-dsh-feature-id": feature.featureId },
              h("div", { className: "dshMaintenance__head" }, h("h3", null, t(featureLabels[feature.featureId] || feature.featureId)), h("span", null, t(statusLabel(feature.availability)))),
              feature.reasonCodes.map((code) => h("p", { key: code, className: "dshMaintenance__note" }, reason(code))),
              h(
                "details",
                null,
                h("summary", null, t("\u67E5\u770B\u8BE6\u60C5")),
                h(
                  "dl",
                  null,
                  row("\u5F53\u524D\u5B9E\u73B0", feature.implementation ? t({ desktop: "\u684C\u9762\u8865\u5145", upstream: "\u4E0A\u6E38\u539F\u751F", hybrid: "\u6DF7\u5408\u5B9E\u73B0" }[feature.implementation]) : t("\u672A\u77E5")),
                  row("\u63D2\u4EF6\u72B6\u6001", t({ enabled: "\u5DF2\u542F\u7528", "user-disabled": "\u7528\u6237\u5DF2\u5173\u95ED", "pending-restart": "\u5F85\u91CD\u542F", "load-failed": "\u52A0\u8F7D\u5931\u8D25", unknown: "\u672A\u77E5" }[feature.pluginState] || "\u672A\u77E5")),
                  row("\u9002\u7528\u8303\u56F4", t(feature.scope === "current-interface" ? "\u5F53\u524D\u754C\u9762" : feature.scope === "current-workspace" ? "\u5F53\u524D\u5DE5\u4F5C\u533A" : "\u5168\u5C40")),
                  row("\u9A8C\u8BC1\u4FE1\u606F", t(feature.verification?.length ? "\u5DF2\u9A8C\u8BC1\u5217\u51FA\u7684\u9694\u79BB\u73AF\u5883\u573A\u666F\uFF1B\u4E0D\u4EE3\u8868\u6574\u7248\u6216\u5176\u4ED6\u73AF\u5883\u5168\u90E8\u517C\u5BB9\u3002" : "\u5C1A\u65E0\u5339\u914D\u7248\u672C\u548C\u67B6\u6784\u7684\u9A8C\u8BC1\u8BB0\u5F55"))
                ),
                feature.verification?.map((record, index) => h(
                  "div",
                  { key: index, className: "dshMaintenance__note" },
                  h("p", null, record.date + " \xB7 DSH " + record.version + " \xB7 " + record.platform + " " + record.architecture + " \xB7 " + t(record.nativeHostMocked ? "\u5BBF\u4E3B\u63A5\u53E3\u6A21\u62DF" : "\u771F\u5B9E\u684C\u9762\u5BBF\u4E3B")),
                  h("p", null, record.checks.map((check) => t(verificationLabels[check] || check)).join(" \xB7 ")),
                  h("code", null, record.evidence)
                )),
                feature.evidence.map((evidence) => h("code", { key: evidence }, evidence))
              )
            ))
          )
        );
      }
      function Section({ kind }) {
        useLocale(React);
        const state = React.useSyncExternalStore(store?.subscribe || (() => () => {
        }), store?.getSnapshot || (() => null));
        React.useEffect(() => {
          if (store && kind === "diagnostics") void store.refresh();
        }, [kind]);
        if (!desktop) return h("div", { className: "dshMaintenance" }, h("p", null, t("\u8BCA\u65AD\u548C\u7EF4\u62A4\u64CD\u4F5C\u8BF7\u5728\u7535\u8111\u684C\u9762\u5E94\u7528\u4E2D\u6267\u884C\u3002")));
        if (kind === "backup") return h("div", { className: "dshMaintenance" }, h(BackupTools), h(RecoveryPackages));
        const report = state.report && isCurrent(state.report, window.__DSH_REMOTE_IDENTITY__) ? state.report : null;
        const controls = h(
          "div",
          { className: "dshMaintenance__actions" },
          h(Button, { onClick: async () => {
            await window.__DSH_CAPABILITIES__?.refresh();
            return store.check();
          }, disabled: state.busy }, t("\u91CD\u65B0\u68C0\u6D4B")),
          kind === "diagnostics" && h(Button, { onClick: () => store.export(), disabled: state.busy || !report }, t("\u5BFC\u51FA\u8BCA\u65AD\u62A5\u544A"))
        );
        let content;
        if (report && kind === "diagnostics") {
          const rt = report.runtime;
          content = h(
            React.Fragment,
            null,
            h("div", { className: "dshMaintenance__card" }, h(
              "dl",
              null,
              row("\u684C\u9762\u7248\u672C", rt.desktopVersion),
              row("\u67B6\u6784", rt.architecture),
              row("\u5B9E\u9645 dsh \u7248\u672C", rt.dshVersion),
              row("\u5B9E\u9645\u8FD0\u884C\u5165\u53E3", rt.dshEntry),
              row("\u8FD0\u884C\u65F6\u6765\u6E90", t(sourceLabels[rt.dshSource] || "\u672A\u77E5")),
              row("Node \u7248\u672C", rt.nodeVersion),
              row("npm \u7248\u672C", rt.npmVersion),
              row("WebView2 \u7248\u672C", rt.webviewVersion),
              row("\u540E\u7AEF\u72B6\u6001", t(rt.backendLoaded ? "\u754C\u9762\u5DF2\u52A0\u8F7D" : "\u7B49\u5F85\u754C\u9762\u52A0\u8F7D")),
              row("\u6700\u8FD1\u68C0\u67E5", report.checkedAt ? new Date(report.checkedAt).toLocaleString() : t("\u5C1A\u672A\u6267\u884C\u68C0\u67E5"))
            )),
            report.checks.map((check) => h("div", { key: check.id, className: "dshMaintenance__card" }, h("div", { className: "dshMaintenance__head" }, h("strong", null, t(checkLabels[check.id] || check.id)), h("span", null, t(statusLabel(check.status)))), h("p", { className: "dshMaintenance__note" }, reason(check.reasonCode)))),
            h(FeatureStatus, { report }),
            h("p", { className: "dshMaintenance__note" }, t("\u9ED8\u8BA4\u62A5\u544A\u7701\u7565\u79C1\u4EBA\u8DEF\u5F84\u3001\u51ED\u636E\u3001\u804A\u5929\u6B63\u6587\u548C\u539F\u59CB\u5B50\u8FDB\u7A0B\u8F93\u51FA\uFF0C\u5305\u542B\u7ED3\u6784\u5316\u72B6\u6001\u3001\u68C0\u67E5\u7ED3\u679C\u53CA\u80FD\u529B\u6E05\u5355\u3002")),
            report.incompleteOperations.length > 0 && h("p", { role: "alert" }, t("\u53D1\u73B0\u672A\u5B8C\u6210\u7684\u7EF4\u62A4\u8BB0\u5F55\uFF0C\u8BF7\u4FDD\u7559\u6062\u590D\u6750\u6599\u3002")),
            report.incompleteOperations.map((record) => h(
              "div",
              { key: record.operationId, className: "dshMaintenance__card" },
              h("p", null, new Date(record.updatedAt).toLocaleString() + " \xB7 " + t(operationLabels[record.kind] || record.kind) + " \xB7 " + t(stageLabels[record.stage] || record.stage)),
              record.errorCode && h("p", { className: "dshMaintenance__note" }, reason(record.errorCode))
            )),
            report.unreadableJournals > 0 && h("p", { role: "alert" }, t("\u90E8\u5206\u7EF4\u62A4\u8BB0\u5F55\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u4FDD\u7559\u6587\u4EF6\u5E76\u67E5\u770B\u8BCA\u65AD\u3002"))
          );
        }
        return h(
          "div",
          { className: "dshMaintenance", "aria-busy": state.busy },
          controls,
          state.busy && h("p", { role: "status" }, t("\u6B63\u5728\u6267\u884C\u8BCA\u65AD\u64CD\u4F5C\u2026")),
          state.error && h("p", { role: "alert", className: "dshMaintenance__error" }, reason(state.error)),
          state.exported && h("p", { role: "status" }, t("\u62A5\u544A\u5DF2\u4FDD\u5B58\uFF1A{path}", { path: state.exported })),
          report ? content : h("p", { role: "status" }, t("\u7B49\u5F85\u8BFB\u53D6\u5F53\u524D\u8FD0\u884C\u65F6\u72B6\u6001\u2026"))
        );
      }
      function MaintenanceDialogs() {
        useLocale(React);
        const [kind, setKind] = React.useState(null);
        React.useEffect(() => {
          const open = (event) => {
            const next = event.detail?.kind;
            if (next === null || desktop && ["diagnostics", "backup"].includes(next)) setKind(next);
          };
          document.addEventListener("dsh-desktop:maintenance-dialog", open);
          return () => document.removeEventListener("dsh-desktop:maintenance-dialog", open);
        }, []);
        if (!kind) return null;
        return h(Modal, {
          open: true,
          onClose: () => setKind(null),
          title: t(kind === "diagnostics" ? "\u8BCA\u65AD" : "\u5907\u4EFD\u4E0E\u6062\u590D"),
          closeLabel: t("\u5173\u95ED\u5F39\u7A97"),
          className: "dshMaintenance__dialog",
          contentClassName: "dshMaintenance__content"
        }, h(Section, { key: kind, kind }));
      }
      const off = ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "desktop-maintenance-dialogs", order: 10 }, MaintenanceDialogs));
      return () => {
        off?.();
        store?.dispose();
        style.remove();
      };
    }
    return { inject: ["slots", "locale"], apply };
  } });
})();
