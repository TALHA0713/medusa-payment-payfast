/**
 * 
Step 1. Initiating Payment request

Step 2. Redirecting user to PayFast Standard Checkout page

Step 3. Redirecting user to Merchant web page

Step 4. Status verification post redirection to merchant website

Step 5. Handling Payment Success, Pending and Failure

Step 6. Refund
 */

import { EOL } from "os";
import {
  AbstractPaymentProcessor,
  Customer,
  isPaymentProcessorError,
  PaymentProcessorContext,
  PaymentProcessorError,
  PaymentProcessorSessionResponse,
  PaymentSessionStatus,
  Logger,
} from "@medusajs/medusa";
import {
  ErrorCodes,
  ErrorIntentStatus,
  PaymentCheckStatusResponse,
  PaymentCheckStatusResponseUPIData,
  PaymentIntentOptions,
  PaymentRequest,
  PaymentResponse,
  PaymentResponseData,
  PaymentResponseUPI,
  PaymentStatusCodeValues,
  PayFastEvent,
  PayFastS2SResponse,
  RefundRequest,
  TransactionIdentifier,
  PayFastOptions
} from "../types";
import { PayFastWrapper } from "./payfast-wrapper";
import { isTooManyTries, retryAsync } from "ts-retry";

abstract class PayFastBase extends AbstractPaymentProcessor {
  static identifier = "";

  protected readonly options_: PayFastOptions;
  protected payfast_: PayFastWrapper;
  protected logger: Logger;
  static sequenceCount = 0;
  protected constructor(container: { logger: Logger }, options) {
    super(container as any, options);
    this.logger = container.logger;
    this.options_ = options;

    this.init();
  }

  protected init(): void {
    this.payfast_ =
      this.payfast_ ||
      new PayFastWrapper(
        {
          salt: this.options_.salt,
          merchantId: this.options_.merchantId,
          callbackUrl: this.options_.callbackUrl ?? "http://localhost:9000",
          redirectMode: this.options_.redirectMode,
          redirectUrl: this.options_.redirectUrl,
          mode: this.options_.mode,
        },
        this.logger
      );
  }

  abstract get paymentIntentOptions(): PaymentIntentOptions;

  getPaymentIntentOptions(): PaymentIntentOptions {
    const options: PaymentIntentOptions = {};

    if (this?.paymentIntentOptions?.capture_method) {
      options.capture_method = this.paymentIntentOptions.capture_method;
    }

    if (this?.paymentIntentOptions?.setup_future_usage) {
      options.setup_future_usage = this.paymentIntentOptions.setup_future_usage;
    }

    if (this?.paymentIntentOptions?.payment_method_types) {
      options.payment_method_types =
        this.paymentIntentOptions.payment_method_types;
    }

    return options;
  }

  async getPaymentStatus({
    merchantId,
    merchantTransactionId,
    data,
  }: {
    merchantId: string;
    merchantTransactionId: string;
    data?: any;
  }): Promise<PaymentSessionStatus> {
    try {
      const currentMerchantId = merchantId ?? data.merchantId;
      const currentMerchantTransactionId =
        merchantTransactionId ?? data.merchantTransactionId;
      const paymentStatusResponse =
        (await this.payfast_.getPayFastTransactionStatus(
          currentMerchantId,
          currentMerchantTransactionId
        )) as PaymentCheckStatusResponse;
      // const data = paymentStatusResponse as PaymentCheckStatusResponse;
      if (this.options_.enabledDebugLogging) {
        this.logger.debug(
          `response from payfast: ${JSON.stringify(paymentStatusResponse)}`
        );
      }
      switch (paymentStatusResponse.code) {
        case "PAYMENT_PENDING":
          return PaymentSessionStatus.PENDING;
        case "BAD_REQUEST":
        case "INTERNAL_SERVER_ERROR":
        case "AUTHORIZATION_FAILED":
          return PaymentSessionStatus.ERROR;
        case "TRANSACTION_NOT_FOUND":
          return PaymentSessionStatus.CANCELED;
        case "PAYMENT_SUCCESS":
          return PaymentSessionStatus.AUTHORIZED;
        default:
          return PaymentSessionStatus.PENDING;
      }
    } catch (e) {
      this.logger.error(`error from payfast: ${JSON.stringify(e)}`);
      const error: PaymentProcessorError = this.buildError("PAYFAST_ERROR", e);
      return PaymentSessionStatus.ERROR;
    }
  }

  async initiatePayment(
    context: PaymentProcessorContext
  ): Promise<PaymentProcessorError | PaymentProcessorSessionResponse> {
    const intentRequestData = this.getPaymentIntentOptions();
    const {
      email,
      context: cart_context,
      currency_code,
      amount,
      resource_id,
      customer,
      paymentSessionData,
    } = context;
    PayFastBase.sequenceCount++;
    const request = await this.payfast_.createPayfastStandardRequest(
      amount.toString(),
      (paymentSessionData.merchantTransactionId as string) ?? resource_id,
      customer?.id ?? email,
      customer?.phone,
      PayFastBase.sequenceCount.toString()
    );
    this.logger.info(
      ` num requests = ${PayFastBase.sequenceCount}, context: ${JSON.stringify(
        context
      )}`
    );

    try {
      let response;
      this.logger.info(
        "payment session data: " + JSON.stringify(paymentSessionData)
      );
      if (paymentSessionData.readyToPay) {
        response = await this.payfast_.postPaymentRequestToPayfast(
          request as PaymentRequest
        );
      } else {
        response = await this.intermediatePaymentResponse(
          request as PaymentRequest
        );
      }
      if (this.options_.enabledDebugLogging) {
        this.logger.info(`response from payfast: ${JSON.stringify(response)}`);
      }
      const result: PaymentProcessorSessionResponse = {
        session_data: {
          ...response,
          customer,
        },
        update_requests: {
          customer_metadata: {
            payfast_id: customer?.id,
          },
        },
      };

      return result;
    } catch (error) {
      this.logger.error(`error from payfast: ${JSON.stringify(error)}`);
      const e = error as Error;
      return this.buildError("initialization error", e);
    }
  }
  async intermediatePaymentResponse(
    request: PaymentRequest
  ): Promise<PaymentResponse> {
    const dummyResponse: PaymentResponseUPI = {
      success: false,
      code: PaymentStatusCodeValues.PAYMENT_INITIATED,
      message: "initiating payment",
      data: {
        merchantId: request.merchantId,
        merchantTransactionId: request.merchantTransactionId,
        instrumentResponse: undefined,
        customer: {
          id: request.merchantUserId,
        },
      },
    };
    return dummyResponse;
  }

  async authorizePayment(
    paymentSessionData: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<
    | PaymentProcessorError
    | {
      status: PaymentSessionStatus;
      data: PaymentProcessorSessionResponse["session_data"];
    }
  > {
    try {
      const { merchantId, merchantTransactionId } = paymentSessionData.data as {
        merchantId: string;
        merchantTransactionId: string;
      };
      const status = await this.checkAuthorizationWithBackOff({
        merchantId,
        merchantTransactionId,
      });
      return { data: paymentSessionData, status };
    } catch (e) {
      const error: PaymentProcessorError = {
        error: e.message,
      };
      return error;
    }
  }

  async checkAuthorizationWithBackOff(
    identifier: TransactionIdentifier
  ): Promise<PaymentSessionStatus> {
    const retryDelays = [3000, 6000, 10000, 30000, 60000];

    for (const delay of retryDelays) {
      try {
        return await this.retryFunction(identifier, delay, 10);
      } catch (error) {
        if (!isTooManyTries(error)) {
          throw error;
        }
      }
    }

    return PaymentSessionStatus.ERROR;
  }

  async retryFunction(
    t: TransactionIdentifier,
    delay: number,
    maxRetry: number
  ): Promise<PaymentSessionStatus> {
    return await retryAsync(
      async () => {
        /* do something */
        return await this.getPaymentStatus(t);
      },
      {
        delay: delay,
        maxTry: maxRetry,
        until: (lastResult) => lastResult === PaymentSessionStatus.AUTHORIZED,
      }
    );
  }

  async deletePayment(
    paymentSessionData: Record<string, unknown>
  ): Promise<
    PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
  > {
    return await this.cancelPayment(paymentSessionData);
  }

  async cancelPayment(
    paymentSessionData: Record<string, unknown>
  ): Promise<
    PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
  > {
    try {
      const id = paymentSessionData.id as string;
      return (await this.payfast_.cancel(
        paymentSessionData
      )) as unknown as PaymentProcessorSessionResponse["session_data"];
    } catch (e) {
      if (e.payment_intent?.status === ErrorIntentStatus.CANCELED) {
        return e.payment_intent;
      }

      return this.buildError("An error occurred in cancelPayment", e);
    }
  }

  async capturePayment(
    paymentSessionData: Record<string, unknown>
  ): Promise<
    PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
  > {
    try {
      const intent = await this.payfast_.capture(paymentSessionData.data as PaymentResponseData);
      return intent as unknown as PaymentProcessorSessionResponse["session_data"];
    } catch (error) {
      if (error.code === ErrorCodes.PAYMENT_INTENT_UNEXPECTED_STATE) {
        if (error.payment_intent?.status === ErrorIntentStatus.SUCCEEDED) {
          return error.payment_intent;
        }
      }

      return this.buildError("An error occurred in capturePayment", error);
    }
  }

  async refundPayment(  
    paymentSessionData: Record<string, unknown>,
    refundAmount: number
  ): Promise<
    PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
  > {
    const pastSession = paymentSessionData.data as PaymentResponseData;
    const refundRequest: RefundRequest = {
      merchantId: pastSession.merchantId,
      originalTransactionId: pastSession.merchantTransactionId,
      amount: refundAmount,
      merchantTransactionId: (paymentSessionData.data as any).merchantTransactionId + "1",
      callbackUrl: `${this.options_.callbackUrl}/hooks/refund`,
      merchantUserId: (paymentSessionData as any).customer?.id,
    };

    try {
      const response = await this.payfast_.postRefundRequestToPayFast(refundRequest);
      if (this.options_.enabledDebugLogging) {
        this.logger.info(`response from payfast: ${JSON.stringify(response)}`);
      }
      return response;
    } catch (e) {
      this.logger.error(`response from payfast: ${JSON.stringify(e)}`);
      return this.buildError("An error occurred in refundPayment", e);
    }
  }
 
  async retrievePayment(
    paymentSessionData: Record<string, unknown>
  ): Promise<
    PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
  > {
    try {
      const request = paymentSessionData.data as PaymentResponseData;
      const intent = await this.payfast_.getPayFastTransactionStatus(
        request.merchantId,
        request.merchantTransactionId
      );
      if (this.options_.enabledDebugLogging) {
        this.logger.info(`response from payfast: ${JSON.stringify(intent)}`);
      }
      return intent as unknown as PaymentProcessorSessionResponse["session_data"];
    } catch (e) {
      this.logger.error(`response from payfast: ${JSON.stringify(e)}`);
      return this.buildError("An error occurred in retrievePayment", e);
    }
  }

  async updatePayment(
    context: PaymentProcessorContext
  ): Promise<PaymentProcessorError | PaymentProcessorSessionResponse | void> {
    this.logger.info(
      `update request context from medusa: ${JSON.stringify(context)}`
    );
    const result = await this.initiatePayment(context);
    return result;
  }

  async updatePaymentData(
    sessionId: string,
    data: Record<string, unknown>
  ): Promise<any> {
    if (data.amount) {
      return await this.initiatePayment(
        data as unknown as PaymentProcessorContext
      );
    } else {
      return data as any;
    }
  }

  constructWebhookEvent(encodedData: string, signature: string): PayFastEvent {
    const decodedBody = JSON.parse(atob(encodedData)) as PayFastS2SResponse;
    if (
      this.payfast_.validateWebhook(encodedData, signature, this.options_.salt)
    ) {
      return {
        type: decodedBody.code,
        id: decodedBody.data.merchantTransactionId,
        data: {
          object: decodedBody,
        },
      };
    } else {
      return {
        type: PaymentStatusCodeValues.PAYMENT_ERROR,
        id: decodedBody.data?.merchantTransactionId ?? "error_id",
        data: {
          object: this.buildError(
            "Webhook validation error",
            new Error("error validating data")
          ) as any,
        },
      };
    }
  }

  protected buildError(message: string, error: Error): PaymentProcessorError {
    return {
      error: message,
      code: isPaymentProcessorError(error) ? error.code : error.name,
      detail: isPaymentProcessorError(error)
        ? `${error.error}${EOL}${error.detail || ""}`
        : error.message || "",
    };
  }
}

export default PayFastBase;