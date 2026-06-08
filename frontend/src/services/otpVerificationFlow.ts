import { createApiTransport } from "./transport";

export type OtpStage = "idle" | "mobile" | "otp" | "uhid" | "verified" | "error";

export interface OtpUhidOption {
  uhid: string;
  fullName?: string;
  dob?: string;
}

export interface OtpFlowState {
  stage: OtpStage;
  mobileNumber?: string;
  challengeId?: string;
  uhidOptions: OtpUhidOption[];
  selectedUhid?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MobileVerificationResponse {
  status: "otp_sent" | "otp_verified" | "uhid_selected";
  challenge_id?: string;
  uhid_options?: OtpUhidOption[];
  selected_uhid?: string;
  error_code?: string;
  error_message?: string;
}

export const OTP_ERROR_MESSAGES: Record<string, string> = {
  otp_not_found: "We could not find an active OTP. Please request a new OTP.",
  invalid_otp: "That OTP looks invalid. Please re-check and try again.",
  tool_error: "Verification service is temporarily unavailable. Please try again.",
  invalid_mobile_number: "Please enter a valid mobile number.",
  invalid_uhid: "That UHID selection is invalid. Please choose a listed option.",
  user_not_authenticated: "Session verification expired. Please start again with your mobile number.",
};

export function initialOtpFlowState(): OtpFlowState {
  return {
    stage: "idle",
    uhidOptions: [],
  };
}

export function mapOtpErrorMessage(errorCode?: string, fallback?: string): string {
  if (!errorCode) return fallback ?? "Could not complete verification. Please try again.";
  return OTP_ERROR_MESSAGES[errorCode] ?? fallback ?? "Could not complete verification. Please try again.";
}

export function reduceOtpFlowState(prev: OtpFlowState, response: MobileVerificationResponse): OtpFlowState {
  if (response.error_code) {
    return {
      ...prev,
      stage: response.error_code === "user_not_authenticated" ? "mobile" : "error",
      errorCode: response.error_code,
      errorMessage: mapOtpErrorMessage(response.error_code, response.error_message),
    };
  }

  if (response.status === "otp_sent") {
    return {
      ...prev,
      stage: "otp",
      challengeId: response.challenge_id,
      errorCode: undefined,
      errorMessage: undefined,
    };
  }

  if (response.status === "otp_verified") {
    const options = response.uhid_options ?? [];
    if (options.length > 0) {
      return {
        ...prev,
        stage: "uhid",
        uhidOptions: options,
        errorCode: undefined,
        errorMessage: undefined,
      };
    }
    return {
      ...prev,
      stage: "verified",
      selectedUhid: undefined,
      uhidOptions: [],
      errorCode: undefined,
      errorMessage: undefined,
    };
  }

  if (response.status === "uhid_selected") {
    return {
      ...prev,
      stage: "verified",
      selectedUhid: response.selected_uhid,
      errorCode: undefined,
      errorMessage: undefined,
    };
  }

  return prev;
}

const transport = createApiTransport({
  agentId: "apollo-assist-web",
});

export async function submitMobileVerificationStage(params: {
  sessionId: string;
  stage: "mobile" | "otp" | "uhid";
  mobileNumber?: string;
  otp?: string;
  selectedUhid?: string;
  leadDescription?: string;
  challengeId?: string;
}): Promise<MobileVerificationResponse> {
  return transport.requestJson<MobileVerificationResponse>({
    path: "/api/tools/mobile-verification",
    method: "POST",
    sessionId: params.sessionId,
    body: {
      tool_params: {
        stage: params.stage,
        mobile_number: params.mobileNumber,
        otp: params.otp,
        selected_uhid: params.selectedUhid,
        lead_description: params.leadDescription,
        challenge_id: params.challengeId,
      },
    },
    retries: 1,
  });
}
