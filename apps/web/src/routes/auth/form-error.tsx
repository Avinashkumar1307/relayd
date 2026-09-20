import { useState } from 'react';
import { ApiError } from '../../api/client.js';

/**
 * Form-level errors on the auth pages.
 *
 * The frames draw no banner on B1–B6 — every error they show is a field
 * error — so the shape borrowed here is B5b's inline note: a 10/12 box at
 * radius 8 in 13px text, in the danger tone rather than info. A field error
 * still goes to the field; this is only for the ones that belong to no
 * single input ("Email or password is incorrect").
 */
export function FormError({ message }: { message: string | undefined }) {
  if (message === undefined || message === '') return null;

  return (
    <div role="alert" className="rounded-control bg-danger-soft px-3 py-2.5 text-ui text-danger-text">
      {message}
    </div>
  );
}

/** Turns a server error into either field errors or a form-level message. */
export function useSubmitError() {
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const handle = (error: unknown, setFieldError?: (path: string, message: string) => void): void => {
    if (error instanceof ApiError) {
      const fields = error.fieldErrors();
      const paths = Object.keys(fields);

      if (paths.length > 0 && setFieldError !== undefined) {
        for (const path of paths) setFieldError(path, fields[path] ?? 'Invalid');
        return;
      }
      setFormError(error.message);
      return;
    }
    setFormError('Something went wrong. Please try again.');
  };

  return { formError, setFormError, handle };
}
