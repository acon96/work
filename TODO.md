# TODO

- [ ] Finish setting up linters, language servers, and a python runtime in the docker image
- [ ] Add Docker healthchecks for squid, dnsmasq, and pi-web services 
- [x] Generate SSL cert for MITM on first boot and stash in a volume somewhere
- [ ] set up the proxy so we can run a new "mode C" where the researcher subagents can do the get-allowed style (Mode B) and the normal agents can use the allow-list (Mode A); could also consider just having a "toggle_sandbox_mode" tool
- [ ] background session renaming based on summary of the conversation (custom extension)
- [x] Sudo enforcement via dynamically-generated immutable /etc/sudoers (allowlist converted at container startup, then chattr +i)