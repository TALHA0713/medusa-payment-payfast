import axios from "axios";
import {
  createGetChecksumHeader,
  createPostPaymentChecksumHeader,
  createPostRefundChecksumHeader,
  createPostValidateVpaChecksumHeader,
  verifyPostCheckSumHeader,
} from "../api/utils/utils";
import {
  PaymentCheckStatusResponse,
  PaymentRequest,
  PaymentRequestUPI,
  PaymentRequestUPICollect,
  PaymentRequestUPIQr,
  PaymentResponse,
  PaymentResponseData,
  PaymentStatusCodeValues,
  RefundRequest,
  PayFastOptions,
} from "../types";
import {
  Logger,
  PaymentProcessorError,
  PaymentSessionData,
} from "@medusajs/medusa";

export class PayFastWrapper {
  options: PayFastOptions;
  url: string;
  logger: Logger | Console;

  constructor(options: PayFastOptions, logger?: Logger) {
    this.logger = logger ?? console;
    this.options = options;
    this.url = this.resolveUrl(options.mode);
  }

  private resolveUrl(mode: string): string {
    const baseUrl = "https://api.payfast.com";
    return mode === "production" || mode === "uat" ? baseUrl : baseUrl;
  }

  private createHeaders(checksum: string, additionalHeaders: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-VERIFY": checksum,
      ...additionalHeaders,
    };
  }

  async postPaymentRequestToPayfast(
    payload: PaymentRequestUPI | PaymentRequestUPICollect | PaymentRequestUPIQr,
    apiNewEndpoint: string = "/pg/v1/pay"
  ): Promise<PaymentResponse | PaymentProcessorError> {
    try {
      const encodedMessage = createPostPaymentChecksumHeader(payload);
      const headers = this.createHeaders(encodedMessage.checksum);
      const response = await axios.post(
        `${this.url}${apiNewEndpoint}`,
        { request: encodedMessage.encodedBody },
        { headers }
      );
      return response.data;
    } catch (error) {
      this.logger.error("Error posting payment request:", error);
      throw error;
    }
  }

  validatePaymentRequest(paymentRequest: PaymentRequest): boolean {
    const {
      merchantId,
      merchantTransactionId,
      amount,
      merchantUserId,
      redirectUrl,
      redirectMode,
      callbackUrl,
    } = paymentRequest;

    return (
      merchantId.length > 0 && merchantId.length < 38 &&
      merchantTransactionId.length > 0 && merchantTransactionId.length < 38 &&
      typeof amount === "number" && !isNaN(amount) &&
      merchantUserId.length > 0 && merchantUserId.length < 36 &&
      /^[\w]+$/.test(merchantUserId) &&
      redirectUrl.startsWith("http") &&
      !!redirectMode &&
      !!callbackUrl
    );
  }

  async createPayfastStandardRequest(
    amount: string,
    merchantTransactionId: string,
    customerId: string,
    mobileNumber?: string,
    attemptId?: string
  ): Promise<PaymentRequest | PaymentProcessorError> {
    const payFastRequest: PaymentRequest = {
      merchantId: this.options.merchantId,
      redirectMode: this.options.redirectMode,
      redirectUrl: this.options.redirectUrl || "https://localhost:8000",
      merchantTransactionId: `${merchantTransactionId}_${attemptId}`,
      merchantUserId: customerId,
      amount: parseInt(amount, 10),
      callbackUrl: this.options.callbackUrl,
      mobileNumber,
      paymentInstrument: { type: "PAY_PAGE" },
    };

    return this.validatePaymentRequest(payFastRequest)
      ? payFastRequest
      : {
          code: "VALIDATION_FAILED",
          error: `${JSON.stringify(payFastRequest)} is invalid`,
        };
  }

  async getPayFastTransactionStatus(
    merchantId: string,
    merchantTransactionId: string,
    apiNewEndpoint: string = "/pg/v1/status"
  ): Promise<PaymentCheckStatusResponse> {
    if (!merchantId || !merchantTransactionId) {
      return {
        data: {
          success: false,
          code: PaymentStatusCodeValues.PAYMENT_ERROR,
          message: "merchantId or merchantTransactionId is incomplete",
        },
      } as any;
    }

    try {
      const encodedMessage = createGetChecksumHeader(merchantId, merchantTransactionId);
      const headers = this.createHeaders(encodedMessage.checksum, {
        "X-MERCHANT-ID": merchantId,
      });
      const response = await axios.get(
        `${this.url}${apiNewEndpoint}/${merchantId}/${merchantTransactionId}`,
        { headers }
      );
      return response.data;
    } catch (error) {
      this.logger.error("Error fetching transaction status:", error);
      throw error;
    }
  }

  async validateVpa(
    merchantId: string,
    vpa: string,
    apiNewEndpoint: string = "/pg/v1/vpa/validate"
  ): Promise<any> {
    try {
      const encodedMessage = await createPostValidateVpaChecksumHeader({ merchantId, vpa });
      const headers = this.createHeaders(encodedMessage.checksum, {
        "X-MERCHANT-ID": merchantId,
      });
      const response = await axios.post(
        `${this.url}${apiNewEndpoint}`,
        { request: encodedMessage.encodedBody },
        { headers }
      );
      return response.data;
    } catch (error) {
      this.logger.error("Error validating VPA:", error);
      throw error;
    }
  }

  async cancel(paymentSessionData: PaymentSessionData): Promise<PaymentSessionData> {
    paymentSessionData.code = undefined;
    return paymentSessionData;
  }

  async capture(paymentResponseData: PaymentResponseData): Promise<PaymentCheckStatusResponse> {
    const { merchantId, merchantTransactionId } = paymentResponseData;
    return this.getPayFastTransactionStatus(merchantId, merchantTransactionId);
  }

  async postRefundRequestToPayFast(
    payload: RefundRequest,
    apiNewEndpoint: string = "/pg/v1/refund"
  ): Promise<any> {
    try {
      const encodedMessage = await createPostRefundChecksumHeader(payload);
      const headers = this.createHeaders(encodedMessage.checksum);
      const response = await axios.post(
        `${this.url}${apiNewEndpoint}`,
        { request: encodedMessage.encodedBody },
        { headers }
      );
      return response.data;
    } catch (error) {
      this.logger.error("Error posting refund request:", error);
      throw error;
    }
  }

  validateWebhook(data: string, signature: string, salt: string): boolean {
    const { checksum } = verifyPostCheckSumHeader(data, salt, "");
    const isValid = checksum === signature;
    this.logger.debug(
      `verifying checksum received: ${signature}, computed: ${checksum}`
    );
    if (isValid) this.logger.info("Valid checksum");
    return isValid;
  }
}
