import "source-map-support/register"
import createHttpError from "http-errors"
import Stripe from "stripe"
import { middyfy } from "../../../helpers/wrapper"
import {
  get, inTransaction, plusT, update, updateT,
} from "../../../helpers/db"
import { stripeWebhookRequest } from "../../../helpers/schemas"
import { donationTable, fundraiserTable, paymentTable } from "../../../helpers/tables"
import env from "../../../env/env"
import { auditContext } from "../../../helpers/auditContext"

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2020-08-27", typescript: true, timeout: 30_000 })

export const main = middyfy(stripeWebhookRequest, null, false, async (event) => {
  // TODO: remove this after serverless-offline fixed: https://github.com/dherault/serverless-offline/pull/1288
  const signature = env.STAGE === "local" ? event.headers["Stripe-Signature"] : event.headers["stripe-signature"]
  if (!signature) throw new createHttpError.Unauthorized("Missing Stripe-Signature header")
  try {
    stripe.webhooks.constructEvent(
      event.rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    )
  } catch (err) {
    throw new createHttpError.Unauthorized("Failed to validate webhook signature")
  }
  auditContext.value!.subject = "stripe"

  if (event.body.data.object.amount !== event.body.data.object.amount_received) {
    throw new createHttpError.BadRequest("amount does not match amount_received")
  }

  const { fundraiserId, donationId, paymentId } = event.body.data.object.metadata

  const [fundraiser, donation, payment] = await Promise.all([
    get(fundraiserTable, { id: fundraiserId }),
    get(donationTable, { fundraiserId, id: donationId }),
    get(paymentTable, { donationId, id: paymentId }),
  ])

  if (event.body.data.object.amount !== payment.donationAmount + payment.contributionAmount) {
    throw new createHttpError.BadRequest("payment intent amount does not match sum of donationAmount and contributionAmount on payment")
  }

  if (payment.reference && event.body.data.object.id !== payment.reference) {
    throw new createHttpError.BadRequest("payment intent id does not match reference on payment")
  }

  if (payment.status !== "pending" && payment.status !== "paid") {
    throw new createHttpError.BadRequest(`payment in invalid state ${payment.status} to be confirmed`)
  }

  // If the payment is not pending, we've already done this. We should only do this if the payment is still pending.
  if (payment.status === "pending") {
    const matchFundingAdded = payment.matchFundingAmount !== null ? payment.matchFundingAmount : Math.max(Math.min(Math.floor(payment.donationAmount * (fundraiser.matchFundingRate / 100)), fundraiser.matchFundingRemaining ?? Infinity, (fundraiser.matchFundingPerDonationLimit ?? Infinity) - donation.matchFundingAmount), 0)

    // If recurring, create a Stripe customer and attach this payment method to them
    if (event.body.data.object.setup_future_usage !== null) {
      const stripeCustomer = await stripe.customers.create({
        name: donation.donorName,
        email: donation.donorEmail,
        metadata: {
          fundraiserId,
          donationId,
        },
        payment_method: event.body.data.object.payment_method,
      })
      await update(donationTable, { fundraiserId, id: donationId }, { stripeCustomerId: stripeCustomer.id, stripePaymentMethodId: event.body.data.object.payment_method })
    }

    await inTransaction([
      // Mark the payment as paid
      updateT(
        paymentTable,
        { donationId, id: paymentId },
        { status: "paid", matchFundingAmount: matchFundingAdded },
        // Validate the reference and amounts have not changed since we got the data and did our custom validation, and that the payment is pending
        "#reference = :cReference AND #donationAmount = :cDonationAmount AND #contributionAmount = :cContributionAmount AND #matchFundingAmount = :pMatchFundingAmount AND #status = :pStatus",
        {
          ":cReference": payment.reference, ":cDonationAmount": payment.donationAmount, ":cContributionAmount": payment.contributionAmount, ":pMatchFundingAmount": payment.matchFundingAmount, ":pStatus": "pending",
        },
        {
          "#reference": "reference", "#donationAmount": "donationAmount", "#contributionAmount": "contributionAmount", "#matchFundingAmount": "matchFundingAmount", "#status": "status",
        },
      ),
      plusT(
        donationTable,
        { fundraiserId, id: donationId },
        {
          donationAmount: payment.donationAmount, contributionAmount: payment.contributionAmount, matchFundingAmount: matchFundingAdded, donationCounted: true,
        },
        // Validate the matchFundingAmount has not changed since we got the data so that we do not violate the matchFundingPerDonation limit
        // Validate the donationCounted has not changed since we got the data so that we do not double count donations
        "matchFundingAmount = :currentMatchFundingAmount AND donationCounted = :currentDonationCounted",
        { ":currentMatchFundingAmount": donation.matchFundingAmount, ":currentDonationCounted": donation.donationCounted },
      ),
      // If matchFundingRemaining === null there is no overall limit on match funding
      //   If this is the case, we need to check that is still the case at the point of crediting the amount on the donation
      //   Otherwise, we need to check that there is still enough match funding left for this payment
      // We also validate that the matchFundingPerDonationLimit has not changed since we just got the data
      fundraiser.matchFundingRemaining === null
        ? plusT(fundraiserTable, { id: fundraiserId }, { totalRaised: payment.donationAmount + matchFundingAdded, donationsCount: donation.donationCounted ? 0 : 1 }, "matchFundingRemaining = :matchFundingRemaining AND matchFundingPerDonationLimit = :matchFundingPerDonationLimit", { ":matchFundingRemaining": fundraiser.matchFundingRemaining, ":matchFundingPerDonationLimit": fundraiser.matchFundingPerDonationLimit })
        : plusT(fundraiserTable, { id: fundraiserId }, { totalRaised: payment.donationAmount + matchFundingAdded, matchFundingRemaining: -matchFundingAdded, donationsCount: donation.donationCounted ? 0 : 1 }, "matchFundingRemaining >= :matchFundingAdded AND matchFundingPerDonationLimit = :matchFundingPerDonationLimit", { ":matchFundingAdded": matchFundingAdded, ":matchFundingPerDonationLimit": fundraiser.matchFundingPerDonationLimit }),
    ])
  }

  // TODO: send a confirmation email if they've consented to receiving informational emails

  // TODO: for the first of a series of recurring donations, maybe confirm future payments' matchFundingAmounts now?
})
