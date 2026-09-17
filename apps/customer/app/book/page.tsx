import { Suspense } from 'react';
import BookFlow from './BookFlow';

export default function BookPage() {
  return (
    <Suspense fallback={null}>
      <BookFlow />
    </Suspense>
  );
}
