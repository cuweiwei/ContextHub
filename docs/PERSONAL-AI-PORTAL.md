# Personal AI Portal integration

ContextHub remains the semantic Memory authority. The Personal AI Portal may
read the existing Control Center projection, but it does not copy Memory into
its own database and it cannot perform review, successor, policy, enrollment,
or other mutations through forwarded browser identity.

## Trust boundary

- The Personal AI private edge authenticates the owner on the canonical Portal
  origin and forwards verified identity headers only on the private upstream
  path.
- ContextHub accepts those headers only when the feature is enabled, the
  request host equals `CONTROL_CENTER_PAI_ORIGIN`, and the method is `GET`,
  `HEAD`, or `OPTIONS`.
- The forwarded owner ID must already exist as a non-disabled
  `personal-ai` web principal. The principal must be linked to a human client;
  normal namespace, source, sensitivity, trust, and audit policies still apply.
- Portal mutations fail closed. A future mutation path must use a bounded,
  short-lived signed action grant; it must not reuse this forwarded session.

## Owner enrollment gate

Before enabling the Portal route in production, the root-controlled operations
workflow must obtain the owner UUID from the Personal AI Identity Gateway and
run the existing ContextHub CLI inside the production application boundary:

```text
node dist/cli.js web-principal-add --provider personal-ai --subject <PAI_OWNER_ID> --name "Owner" --control-admin
node dist/cli.js web-principal-link --provider personal-ai --subject <PAI_OWNER_ID> --client <HUMAN_CLIENT_ID>
```

Do not place the owner UUID in Git as a substitute for enrollment, and do not
create a service token. Successful local tests prove only `implemented_local`;
they do not prove that the production principal link or Portal route is live.
