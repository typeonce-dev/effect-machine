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

const AuthStates = Machine.states({
  Editing: {
    schema: AuthState.cases.Editing,
    initial: "Form",
    states: {
      Form: {
        initial: "Ready",
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
    initial: "CodeEntry",
    states: {
      CodeEntry: {}
    }
  },
  Navigating: AuthState.cases.Navigating
})

const AuthEvents = Machine.events(
  Schema.TaggedUnion({
    EmailChanged: { value: Schema.String },
    LoginMethodChanged: { value: LoginMethod },
    PasswordChanged: { value: Schema.String },
    Submit: { route: Schema.Literals(["verification", "login", "invalid"]) }
  })
)

export const layoutResilienceMachine = Machine.make({
  id: "layout-resilience",
  states: AuthStates.states,
  events: AuthEvents,
  initial: (to) =>
    to.Editing.initial.resolve(({ target }) =>
      target.from({
        mode: "login",
        email: "",
        loginMethod: "code",
        password: ""
      }, (editing) => editing.Form.from((form) => form.Ready.from()))
    )
}).handle({
  Editing: {
    states: {
      Form: {
        on: {
          EmailChanged: (to) =>
            to.branch.Editing.update(({ current, event, owner }) => owner.from({ ...current, email: event.value })),
          LoginMethodChanged: (to) =>
            to.branch.Editing.update(({ current, event, owner }) =>
              owner.from({ ...current, loginMethod: event.value })
            ),
          PasswordChanged: (to) =>
            to.branch.Editing.update(({ current, event, owner }) => owner.from({ ...current, password: event.value })),
          Submit: (to) =>
            to.branches({
              requestVerification: {
                title: "Request a verification code",
                target: to.branch.Editing.RequestingVerification()
              },
              login: {
                title: "Submit password login",
                target: to.branch.Editing.SubmittingLogin()
              },
              invalid: {
                title: "Show validation failure",
                target: to.local.Failed()
              }
            }).resolve(({ event, select }) => {
              if (event.route === "login") return select.login.from()
              if (event.route === "verification") return select.requestVerification.from()
              return select.invalid.from({ message: "Enter valid authentication details." })
            })
        },
        states: {
          Ready: {},
          Failed: {}
        }
      },
      SubmittingLogin: {
        invoke: (from) =>
          from.effect("submit-login", ({ containingState }) =>
            containingState.email === "fail"
              ? Effect.fail("invalid credentials")
              : Effect.succeed("/creator")).onDone((to) =>
              to.full.Navigating().resolve(({ output, target }) => target.from({ href: output }))).onFailure((to) =>
              to.branch.Editing.Form.Failed().resolve(({ target }) =>
                target.from({ message: "Email or password is incorrect." })
              ))
      },
      RequestingVerification: {
        invoke: (from) =>
          from.effect("request-verification", ({ containingState }) =>
            containingState.email === "fail"
              ? Effect.fail("verification unavailable")
              : Effect.succeed(undefined)).onDone((to) =>
              to.full.Verification.initial.resolve(({ containingState, target }) =>
                target.from({
                  mode: containingState.mode,
                  email: containingState.email,
                  code: ""
                })
              )).onFailure((to) =>
              to.branch.Editing.Form.Failed().resolve(({ target }) =>
                target.from({ message: "The verification code could not be sent." })
              ))
      }
    }
  },
  Verification: {
    states: {
      CodeEntry: {}
    }
  },
  Navigating: {}
})
