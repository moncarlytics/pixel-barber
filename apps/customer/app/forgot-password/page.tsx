import { Suspense } from 'react';
import ResetFlow from './ResetFlow';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetFlow />
    </Suspense>
  );
}
