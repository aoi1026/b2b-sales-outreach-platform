export type FormInput = {
  company?: string | null;
  person?: string | null;
  email?: string | null;
  phone?: string | null;
  subject?: string | null;
  message?: string | null;
};

export type SubmitResult = {
  status: "success" | "failed";
  errorType?:
    | "TIMEOUT"
    | "FORM_NOT_FOUND"
    | "FIELD_MISMATCH"
    | "SUBMIT_FAILED"
    | "VALIDATION_ERROR"
    | "NETWORK_ERROR"
    | "UNKNOWN";
  errorMessage?: string;
  httpStatus?: number;
};

export type DeliveryJobPayload = {
  jobId: string;
};
