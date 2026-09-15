#!/bin/sh
# Транслятор адресов одного из двух видов.
# Имена переменных латиницей: busybox sh кириллицу в именах не принимает.
set -e
KIND="$1"
GW="$2"
WAN=eth0

# eth0 у роутеров — интерфейс в net0. Определяем по адресу, а не по имени:
# порядок интерфейсов в контейнере не гарантирован.
for i in $(ip -o link | awk -F': ' '{print $2}' | cut -d@ -f1 | grep -v lo); do
  if ip -4 addr show "$i" 2>/dev/null | grep -q 'inet 172.30.'; then WAN="$i"; fi
done

# Наружу — только через транзит: это и добавляет промежуточный узел, без
# которого пакеты с коротким сроком жизни негде проверять.
ip route del default 2>/dev/null || true
ip route add default via "$GW"

iptables -t nat -F
if [ "$KIND" = "symmetric" ]; then
  # Новый порт из узкого окна на каждое новое соединение: внешний порт
  # меняется от получателя к получателю. Это и есть симметричный NAT,
  # причём такой, у которого диапазон можно угадать, — как у многих
  # настоящих. --to-ports работает только с указанным протоколом, поэтому
  # правило для UDP отдельное, а общее — следом, для всего остального.
  iptables -t nat -A POSTROUTING -o "$WAN" -p udp -j MASQUERADE --random-fully --to-ports 45000-45255
  iptables -t nat -A POSTROUTING -o "$WAN" -j MASQUERADE
elif [ "$KIND" = "wild" ]; then
  # Худший случай: порт случаен во всём эфемерном диапазоне. Веер такой не
  # берёт, и это надо уметь показать, а не только рассказать.
  iptables -t nat -A POSTROUTING -o "$WAN" -p udp -j MASQUERADE --random-fully
  iptables -t nat -A POSTROUTING -o "$WAN" -j MASQUERADE
else
  # Обычный домашний: порт сохраняется, отображение одинаково для всех,
  # а впускает только с того адреса и порта, куда писали сами.
  iptables -t nat -A POSTROUTING -o "$WAN" -j MASQUERADE
fi

echo "роутер $KIND поднят, внешний интерфейс $WAN"
iptables -t nat -S POSTROUTING
sleep infinity
