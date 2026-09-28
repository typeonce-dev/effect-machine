import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"
const Mode = Schema.Literals(["login", "signup"])
const LoginMethod = Schema.Literals(["code", "password"])
const AuthState = Schema.TaggedUnion({
  Editing: {
    mode: Mode,
    email: Schema.String,
    loginMethod: LoginMethod,
    password: Schema.String
  },
  EditingFailed: { message: Schema.String },
  Verification: {
    mode: Mode,
    email: Schema.String,
    code: Schema.String
  },
  Navigating: { href: Schema.String }
})
const AuthStates = Machine.state({
  states: {
    Editing: {
      schema: AuthState.cases.Editing,
      states: {
        Form: {
          states: {
            Ready: {},
            Failed: AuthState.cases.EditingFailed
          }
        },
        SubmittingLogin: {},
        RequestingVerification: {}
      }
    },
    Verification: {
      schema: AuthState.cases.Verification,
      states: {
        CodeEntry: {}
      }
    },
    Navigating: AuthState.cases.Navigating
  }
})
const AuthEvents = Machine.eventsFromSchemas(Schema.TaggedUnion({
  EmailChanged: { value: Schema.String },
  LoginMethodChanged: { value: LoginMethod },
  PasswordChanged: { value: Schema.String },
  Submit: { route: Schema.Literals(["verification", "login", "invalid"]) }
}))
export const layoutResilienceMachine = Machine.make({
  branches: {
    transition4: {
      requestVerification: {
        target: "Editing.RequestingVerification",
        title: "Request a verification code"
      },
      login: { target: "Editing.SubmittingLogin", title: "Submit password login" },
      invalid: { target: "Editing.Form.Failed", title: "Show validation failure" }
    }
  },
  effects: {
    source1: ({ containingState }: {
      readonly containingState: {
        readonly email: string
      }
    }) =>
      containingState.email === "fail"
        ? Effect.fail("invalid credentials")
        : Effect.succeed("/creator"),
    source2: ({ containingState }: {
      readonly containingState: {
        readonly email: string
      }
    }) =>
      containingState.email === "fail"
        ? Effect.fail("verification unavailable")
        : Effect.succeed(undefined)
  },
  id: "layout-resilience",
  root: AuthStates,
  events: AuthEvents
}).handle({
  initial: {
    target: "Editing",
    data: {
      mode: "login",
      email: "",
      loginMethod: "code",
      password: ""
    }
  },
  states: {
    Editing: {
      initial: {
        target: "Editing.Form"
      },
      states: {
        Form: {
          initial: {
            target: "Editing.Form.Ready"
          },
          on: {
            EmailChanged: {
              update: "Editing",
              data: ({ ancestors: { "Editing": current }, event }) => ({ ...current, email: event.value })
            },
            LoginMethodChanged: {
              update: "Editing",
              data: ({ ancestors: { "Editing": current }, event }) => ({ ...current, loginMethod: event.value })
            },
            PasswordChanged: {
              update: "Editing",
              data: ({ ancestors: { "Editing": current }, event }) => ({ ...current, password: event.value })
            },
            Submit: {
              branches: "transition4",
              resolve: ({ event, select }) => {
                if (event.route === "login") {
                  return select.login({})
                }
                if (event.route === "verification") {
                  return select.requestVerification({})
                }
                return select.invalid({ data: { message: "Enter valid authentication details." } })
              }
            }
          },
          states: {
            Ready: {},
            Failed: {}
          }
        },
        SubmittingLogin: {
          invoke: {
            src: "source1",
            id: "submit-login",
            input: (context) => context,
            onDone: { target: "Navigating", data: ({ output }) => ({ href: output }) },
            onFailure: {
              target: "Editing.Form.Failed",
              data: () => ({ message: "Email or password is incorrect." })
            }
          }
        },
        RequestingVerification: {
          invoke: {
            src: "source2",
            id: "request-verification",
            input: (context) => context,
            onDone: {
              target: "Verification",
              data: ({ containingState }) => ({
                mode: containingState.mode,
                email: containingState.email,
                code: ""
              })
            },
            onFailure: {
              target: "Editing.Form.Failed",
              data: () => ({ message: "The verification code could not be sent." })
            }
          }
        }
      }
    },
    Verification: {
      initial: {
        target: "Verification.CodeEntry"
      },
      states: {
        CodeEntry: {}
      }
    },
    Navigating: {}
  }
})
