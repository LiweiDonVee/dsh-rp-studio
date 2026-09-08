# Security

This preview is a local application. Gateway and upstream connections are restricted to HTTP loopback; do not expose them through a public proxy. Tokens remain in the Gateway process and are exchanged for authority-specific cookies. Never commit tokens, session logs or user presets.

Only install trusted DSH presets: their runtime code executes in DSH, outside Studio's renderer. The frontend sanitizes narrative HTML and the Gateway filters public state, but neither can detect secrets intentionally placed in public text.

For a vulnerability, use the repository host's private vulnerability reporting if enabled. Otherwise contact the maintainer privately through an established channel before disclosing exploit details. Include version, reproduction and impact with credentials and private content removed. No private reporting endpoint or support commitment is claimed for this preview.
