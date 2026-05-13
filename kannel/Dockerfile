FROM debian:bookworm-slim

# kannel    — bearerbox + smsbox binaries
# gettext-base — provides envsubst for env-var injection into the config
RUN apt-get update \
    && apt-get install -y --no-install-recommends kannel gettext-base \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/kannel /var/spool/kannel/store /var/spool/kannel/dlr \
    && chown -R kannel:nogroup /var/log/kannel /var/spool/kannel

COPY kannel.docker.conf /etc/kannel/kannel.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# smsbox HTTP send API (internal only — not published to host)
EXPOSE 13013

ENTRYPOINT ["/entrypoint.sh"]
