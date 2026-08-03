import { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore';
import { db } from './firebase.js';

/**
 * Given an AgWorld field ID, finds the pivot mapped to it (if any) and
 * live-subscribes to that pivot's status. Returns { pivot, loading }.
 * `pivot` is null if no mapping exists yet for this field.
 */
export function usePivotForField(fieldId) {
  const [pivot, setPivot] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!fieldId) {
      setPivot(null);
      setLoading(false);
      return;
    }

    let unsubPivot = null;

    const mappingQuery = query(
      collection(db, 'pivotFieldMapping'),
      where('fieldId', '==', String(fieldId))
    );

    const unsubMapping = onSnapshot(mappingQuery, (snapshot) => {
      if (unsubPivot) {
        unsubPivot();
        unsubPivot = null;
      }

      if (snapshot.empty) {
        setPivot(null);
        setLoading(false);
        return;
      }

      const { pivotGuid } = snapshot.docs[0].data();
      const pivotRef = doc(db, 'pivots', pivotGuid);

      unsubPivot = onSnapshot(pivotRef, (pivotSnap) => {
        setPivot(pivotSnap.exists() ? pivotSnap.data() : null);
        setLoading(false);
      });
    });

    return () => {
      unsubMapping();
      if (unsubPivot) unsubPivot();
    };
  }, [fieldId]);

  return { pivot, loading };
}
