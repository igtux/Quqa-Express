# Disposable SSH server for the engine's end-to-end tests. Never expose it:
# it accepts a fixed, publicly known password.
FROM alpine:3

RUN apk add --no-cache openssh bash coreutils tmux \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash quqa \
 && echo 'quqa:quqa-test-password' | chpasswd \
 && mkdir -p /home/quqa/.ssh \
 && chown quqa:quqa /home/quqa/.ssh \
 && chmod 700 /home/quqa/.ssh

COPY sshd_config /etc/ssh/sshd_config

EXPOSE 22
# Fresh host keys per container, so the two test servers have different keys.
CMD ["/bin/sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A >/dev/null && exec /usr/sbin/sshd -D -e"]
