#!/bin/sh
# Ключ в стенде задаётся переменной окружения — на настоящей машине его
# подставляет человек в /etc/turnserver.conf своей рукой.
set -e
ip route del default 2>/dev/null || true
ip route add default via 172.30.2.9
МОЙ=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
cp /lab/turnserver.conf /tmp/turnserver.conf
echo "external-ip=$МОЙ" >> /tmp/turnserver.conf
echo "static-auth-secret=$TURN_SECRET" >> /tmp/turnserver.conf
echo "ретранслятор на $МОЙ"
exec turnserver -c /tmp/turnserver.conf -v
