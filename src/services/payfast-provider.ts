import PayFasteBase from "../core/payfast-base";
import { PaymentIntentOptions, PaymentProviderKeys } from "../types";

class PayFastProviderService extends PayFasteBase {
  static identifier = PaymentProviderKeys.PAYFAST;

  constructor(_, options) {
    super(_, options);
  }

  get paymentIntentOptions(): PaymentIntentOptions {
    return {};
  }
}

export default PayFastProviderService;
