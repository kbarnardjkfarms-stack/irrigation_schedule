import { initializeApp } from 'firebase/app'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore'

// ---------------------------------------------------------------------
// Fill these in from your Firebase project settings (Project settings
// > General > Your apps > SDK setup and configuration). See README.md
// for the full "create a free Firebase project" walkthrough.
// ---------------------------------------------------------------------
const firebaseConfig = {
  apiKey: 'AIzaSyBOdc9DPdn2YqW3zG87Qzaj50TmteW4iBY',
  authDomain: 'irrigation-schedule-f8b69.firebaseapp.com',
  projectId: 'irrigation-schedule-f8b69',
  storageBucket: 'irrigation-schedule-f8b69.firebasestorage.app',
  messagingSenderId: '1016145843540',
  appId: '1:1016145843540:web:c7112a3d7061f5e31064c1'
}

const app = initializeApp(firebaseConfig)

// This is the key line for offline support: Firestore keeps a full local
// copy of the data on-device (IndexedDB), reads/writes work instantly with
// no connection, and queued writes flush out automatically the moment the
// device is back online. persistentMultipleTabManager lets it work even if
// someone has the app open in two browser tabs on the same phone.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
})
