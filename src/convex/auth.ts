import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

const CustomPassword = Password({
  profile(params) {
    return {
      email: params.email as string,
      name: (params.name as string) ?? (params.email as string).split("@")[0],
    };
  },
});

export const { auth, signIn, signOut, store } = convexAuth({
  providers: [CustomPassword],
});
