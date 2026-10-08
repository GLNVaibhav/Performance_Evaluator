// Convex Auth provider configuration — required for the deployment to
// validate JWTs issued by the password provider. Without this file every
// authenticated call fails with NoAuthProvider.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
