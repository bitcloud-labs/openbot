# OpenBot docs

Start with the root [README](../README.md), then use these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Development](development.md): local setup, migrations, ports, and quality checks.
- [Coworkers](coworkers.md): durable Bot profiles, channels, visibility, deletion, and external AG-UI registration.
- [Routines](routines.md): standing instructions a Bot runs on a schedule, the worker that fires them, and who they run as.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Google Drive](plugins/google-drive.md)
  - [Notion](plugins/notion.md)
- [Deployment](deployment.md): the container, what is in the image, minimum sizes, and the platform notes.
- [Kubernetes](../charts/openbot/README.md): the Helm chart, what a cluster needs before it, and the values that differ per cloud.
- [Releasing](releasing.md): how a release is proposed, reviewed and published.
- [Launch readiness: OpenBot computers (BitMind as caller)](LAUNCH-READINESS-bitmind-openbot.md): draft findings only — prefers the production-ish `openbot-private` clone (VPS `/home/dev/apps/openbot`) for the BitMind / Bit Bot path. Public `main` is the tracking fork. BitMind itself is an external repo. Do not treat it as a feature or a deploy plan.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
