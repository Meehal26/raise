import type { Env } from "../helpers/types"

const env: Env = {
  STAGE: "prod",

  API_BASE_URL: "https://5kh7xzkn5m.execute-api.eu-west-1.amazonaws.com",

  // OAuth 2 client id for Google sign-in
  GOOGLE_CLIENT_ID: "730827052132-u1tatnr4anip3vf7j5tq82k33gb5okpe.apps.googleusercontent.com",

  // Stripe publishable key
  // The secret key should NEVER be exposed to the front-end
  STRIPE_PUBLISHABLE_KEY: "",

  // Whether to enable login methods
  GOOGLE_LOGIN_ENABLED: true,
  IMPERSONATION_LOGIN_ENABLED: false,
}

export default env