/** What the rating form shows for a submit_feedback error: closed window, already rated (show the
 * thank-you state), or a generic retry message. */
export function feedbackErrorKey(message: string | undefined): 'closed' | 'thanks' | 'generic' {
  if (message === 'too_late') return 'closed';
  if (message === 'already_submitted') return 'thanks';
  return 'generic';
}
