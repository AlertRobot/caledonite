// Caledonite settings. The Firebase part is filled in during setup.
export const APP = {
  name: 'Caledonite',
  version: '1.0.0'
};

// Firebase web app settings (these are public, not secrets; access is controlled by firestore.rules)
export const FIREBASE = {
  sdk: '12.6.0',
  config: null, // { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId }
  vapidKey: ''  // Cloud Messaging > Web Push certificates > Key pair
};

export const HOUSEHOLD_PATH = 'households/main';
