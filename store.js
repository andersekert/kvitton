// Everything is stored in this browser's IndexedDB; nothing leaves the phone until the user shares it.
// Receipt fields live apart from the images so that lists stay fast.

const DB_NAME = 'kvitton';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('trips', { keyPath: 'id' });
      db.createObjectStore('receipts', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeNames, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
    work(stores, (request, map = (value) => value) => {
      request.onsuccess = () => { result = map(request.result); };
    });
  });
}

export const getAll = (store) => run([store], 'readonly', (s, ret) => ret(s[store].getAll()));
export const put = (store, value) => run([store], 'readwrite', (s) => s[store].put(value));
export const getFile = (id) => run(['files'], 'readonly', (s, ret) => ret(s.files.get(id)));
export const putFile = (file) => run(['files'], 'readwrite', (s) => s.files.put(file));

export function addReceipt(receipt, file) {
  return run(['receipts', 'files'], 'readwrite', (s) => {
    s.receipts.put(receipt);
    s.files.put(file);
  });
}

export function deleteReceipts(ids) {
  return run(['receipts', 'files'], 'readwrite', (s) => {
    for (const id of ids) {
      s.receipts.delete(id);
      s.files.delete(id);
    }
  });
}

export function deleteTrip(id, receiptIds) {
  return run(['trips', 'receipts', 'files'], 'readwrite', (s) => {
    s.trips.delete(id);
    for (const receiptId of receiptIds) {
      s.receipts.delete(receiptId);
      s.files.delete(receiptId);
    }
  });
}
