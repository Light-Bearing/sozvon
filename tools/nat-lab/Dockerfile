FROM mirror.gcr.io/library/node:22-alpine
RUN apk add --no-cache iptables iproute2 tcpdump conntrack-tools
COPY *.mjs *.sh /lab/
WORKDIR /lab
