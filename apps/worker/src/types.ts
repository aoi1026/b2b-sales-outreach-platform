export type FormInput = {
  company?: string | null;
  companyKana?: string | null;
  person?: string | null;
  personKana?: string | null;
  personHiragana?: string | null;
  personKatakana?: string | null;
  personFirst?: string | null;
  personLast?: string | null;
  email?: string | null;
  phone?: string | null;
  postalCode?: string | null;
  address?: string | null; // 結合住所 (単一住所欄用)
  prefecture?: string | null; // 都道府県
  city?: string | null; // 市区町村
  addressLine?: string | null; // 丁目番地
  building?: string | null; // ビル名・部屋番号
  url?: string | null;
  subject?: string | null;
  message?: string | null;
  position?: string | null; // 役職
  department?: string | null; // 部署
};

export type SubmitResult = {
  status: "success" | "failed";
  errorType?:
    | "TIMEOUT"
    | "FORM_NOT_FOUND"
    | "FIELD_MISMATCH"
    | "SUBMIT_FAILED"
    | "VALIDATION_ERROR"
    | "CAPTCHA_FAILED"
    | "NETWORK_ERROR"
    | "UNKNOWN";
  errorMessage?: string;
  httpStatus?: number;
  // 送信完了時の全画面スクリーンショット (PNG)。撮影が有効な場合のみ。
  screenshot?: Buffer;
  // AI 解析で実行した送信プラン (フェーズC: 成功時にドメイン別レシピとして学習保存する)。
  recipe?: import("./ai-form-analyzer.ts").FillPlan;
};

export type DeliveryJobPayload = {
  jobId: string;
};
