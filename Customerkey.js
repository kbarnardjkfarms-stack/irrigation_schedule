// One shared definition of how a customer's name becomes a Firestore document
// id. Used by Users.jsx (linking a login to customers), PotatoStorage.jsx
// (publishing each customer's view) and compared against in firestore.rules
// via the `customerKeys` list on a customer's profile — keeping it in one
// place means those can never drift apart.
export function customerKey(name) {
  const key = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return key || 'unnamed'
}
