import { Suspense } from 'react';
import OnboardWizard from './OnboardWizard';

export default function OnboardPage() {
  return (
    <Suspense fallback={null}>
      <OnboardWizard />
    </Suspense>
  );
}
