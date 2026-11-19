const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('clippy', {
  onOffer: on('offer'), // { message, animation }: ask the yes/no question
  onExpire: on('expire'), // the question went unanswered; put it away
  onNotice: on('notice'), // a plain message with no buttons (errors, permissions)
  onLeave: on('leave'), // Clippy goes away for a moment
  onReturn: on('return'), // and comes back
  answer: (choice) => ipcRenderer.send('answer', choice), // 'yes' | 'no'
  setHover: (over) => ipcRenderer.send('hover', over),
});
