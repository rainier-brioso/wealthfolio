# Custom AI provider

The `custom` provider connects to OpenAI-compatible Chat Completions servers,
including Strata. It uses the existing provider catalog, settings, secret store,
model picker, HTTP client and chat streaming paths in both Tauri and Axum.

Configure an explicit HTTP(S) base URL, refresh the model list and enable the
desired models. Both a server root and a URL ending in `/v1` are accepted.
API keys are optional and use the existing `ai_custom` secret-store convention;
without a key, the client omits Authorization. Embedded URL credentials and query
parameters are rejected. Missing or invalid endpoints never fall back to OpenAI.

The provider has no preselected or invented catalog model. Model IDs come from
the server. Model capabilities remain conservative unless the user configures
them using the existing controls. In particular, enable Tools for a model that
supports function calling. Thread titles fall back to that chat model.

Architecture impact: one new catalog entry and validation of its configuration;
no new adapter commands, HTTP routes, storage schema, workers, retries or sync
mechanisms. Custom chat requests validate enabled status, endpoint and model
before thread/message persistence. Provider failures use existing error handling.

For the current Strata server on the PC:

- Base URL: `http://127.0.0.1:8080/v1`
- Model: `qwen3.8-flash-next-coder-iq1_m`
- API key: not required by that server

On another device, localhost refers to that device. Accessing the PC server
requires its reachable network address and the server's existing network setup.
