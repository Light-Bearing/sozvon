// Один и тот же человек может прийти сразу из нескольких каналов.
// Владелец — тот канал, который нашёл его первым; только он везёт медиа.
// Остальные соединения остаются пустыми и почти ничего не стоят.

export const createPeerRegistry = () => {
  const owners = new Map();

  return {
    claim: (peerId, channel) => {
      if (owners.has(peerId)) return false;
      owners.set(peerId, channel);
      return true;
    },
    release: (peerId, channel) => {
      if (owners.get(peerId) !== channel) return false;
      owners.delete(peerId);
      return true;
    },
    ownerOf: peerId => owners.get(peerId),
    peers: () => [...owners.keys()],
  };
};
