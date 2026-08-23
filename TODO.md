# TODO

- [x] Finish setting up linters, language servers, and a python runtime in the docker image
- [x] Add Docker healthchecks for squid, dnsmasq, and pi-web services
- [x] Generate SSL cert for MITM on first boot and stash in a volume somewhere
- [x] set up the proxy so we can run a new "mode C" where the researcher subagents can do the get-allowed style (Mode B) and the normal agents can use the allow-list (Mode A); could also consider just having a "toggle_sandbox_mode" tool
- [x] background session renaming based on summary of the conversation (custom extension)
- [x] Sudo enforcement via dynamically-generated immutable /etc/sudoers (allowlist converted at container startup, then chattr +i)
- [x] need to persist the crontab file properly; right now it resets when the container restarts b/c it's in the agent home dir
- [x] fix scheduler again; it needs `provider/model` not just `model`. the current validation on create is broken
- [x] implement kv cache stashing either in the llama-swap extension (based on https://github.com/Red4Hack/pi-llama-cpp) or putting it in llama-swap directly
- [ ] send prompt processing progress via a "side-channel" in the SSE event stream (could also do model load progress this way)
- [ ] fix the health check probes. the agent socket can crash and the web UI will still be up and never get restarted (container should restart)