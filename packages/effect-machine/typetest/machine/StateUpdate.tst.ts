import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"
class Root extends Schema.TaggedClass<Root>("Root")("Root", { revision: Schema.Number }) {}
class Work extends Schema.TaggedClass<Work>("Work")("Work", { revision: Schema.Number }) {}
class Auth extends Schema.TaggedClass<Auth>("Auth")("Auth", { user: Schema.String }) {}
class Sync extends Schema.TaggedClass<Sync>("Sync")("Sync", { cursor: Schema.Number }) {}
class SignedOut extends Schema.TaggedClass<SignedOut>("SignedOut")("SignedOut", {}) {}
class SignedIn extends Schema.TaggedClass<SignedIn>("SignedIn")("SignedIn", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}
const States = Machine.state({
  states: {
    main: {
      schema: Root,
      states: {
        work: {
          schema: Work,
          type: "parallel",
          states: {
            auth: {
              schema: Auth,
              states: { signedOut: SignedOut, signedIn: { schema: SignedIn, type: "final" } }
            },
            sync: {
              schema: Sync,
              states: { idle: Idle }
            }
          }
        },
        routing: { type: "choice" }
      }
    },
    structural: {
      states: { idle: Idle }
    }
  }
})
describe("Machine state-value updates", () => {
  it("exposes updates only for the valued active ancestor chain", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Tick)
    })
    machine.handle({
      initial: {
        target: "main",
        decoded: true,
        data: new Root({ revision: 0 })
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            decoded: true,
            data: new Work({ revision: 0 })
          },
          states: {
            work: {
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ update: "main.work.auth" }],
                          reenter: true,
                          resolve: ({ ancestors, select, state }) => {
                            expect(state).type.toBe<SignedOut>()
                            expect(ancestors["main.work.auth"]).type.toBe<Auth>()
                            expect(select.update).type.toBeCallableWith({
                              "main.work.auth": { data: new Auth({ user: "next" }), decoded: true }
                            })
                            expect(select.update).type.toBeCallableWith({ "main.work.auth": { user: "next" } })
                            return select.update({
                              "main.work.auth": { decoded: true, data: new Auth({ user: "next" }) }
                            })
                          }
                        }
                      }
                    },
                    signedIn: {}
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    decoded: true,
                    data: new Idle({})
                  },
                  states: { idle: {} }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { idle: {} }
        }
      }
    })
  })
  it("requires the declared retained owner replacement", () => {
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Tick)
    })
    machine.handle({
      initial: {
        target: "structural"
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ target: "main.work.auth.signedIn", update: "main.work.auth" }],
                          resolve: ({ ancestors, select }) => {
                            expect(ancestors["main.work.auth"]).type.toBe<Auth>()
                            expect(select.target).type.toBeCallableWith("main.work.auth.signedIn", {
                              data: {},
                              update: { "main.work.auth": { user: "next" } }
                            })
                            expect(select.target).type.not.toBeCallableWith("main.work.auth.signedIn", {
                              data: {},
                              update: { "main.work.auth": { user: 1 } }
                            })
                            return select.target("main.work.auth.signedIn", {
                              data: new SignedIn({}),
                              decoded: true,
                              update: { "main.work.auth": { decoded: true, data: new Auth({ user: "next" }) } }
                            })
                          }
                        }
                      }
                    },
                    signedIn: {}
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: { idle: {} }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { idle: {} }
        }
      }
    })
    machine.handle({
      initial: {
        target: "structural"
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ target: "main.work.auth.signedIn", update: "main.work.auth" }],
                          resolve: ({ select }) =>
                            // @ts-expect-error! The declared retained owner must be constructed before returning a branch.
                            select.target("main.work.auth.signedIn", {
                              data: new SignedIn({}),
                              decoded: true,
                              update: { "main.work.auth": {} }
                            })
                        }
                      }
                    },
                    signedIn: {}
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: { idle: {} }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { idle: {} }
        }
      }
    })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        main: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ target: "main.work.auth.signedIn", update: "main.work.sync" }],
                          resolve: () => undefined
                        }
                      }
                    }
                  },
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    machine.handle({
      initial: {
        target: "structural"
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ update: "main" }, { decline: true }],
                          resolve: ({ select, ancestors }) =>
                            ancestors.main.revision === 0 ? select.update({ main: { revision: 1 } }) : select.decline()
                        }
                      }
                    },
                    signedIn: {}
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  },
                  states: { idle: {} }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: { idle: {} }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        main: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: [{ update: "main" }, { stay: true }],
                          resolve: () => undefined
                        }
                      }
                    }
                  },
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
  it("rejects updates to structural states, choice updates, and final-state transitions", () => {
    const machine = Machine.make({ root: States, events: Machine.eventsFromSchemas(Tick) })
    expect(machine.handle).type.toBeCallableWith({
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      },
      states: {
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        structural: {
          on: { Tick: { update: { structural: () => ({}) } } },
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        main: {
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          },
          states: {
            work: {
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          }
        }
      },
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        main: {
          states: {
            routing: { choice: { update: { main: () => ({ revision: 1 }) } } },
            work: {
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              },
              states: {
                auth: {
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              }
            }
          },
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        main: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedIn: {
                      on: { Tick: { update: { "main.work.auth": () => ({ user: "next" }) } } }
                    }
                  },
                  initial: {
                    target: "main.work.auth.signedOut",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                },
                sync: {
                  initial: {
                    target: "main.work.sync.idle",
                    data: () => {
                      throw new Error("type-only constructor")
                    }
                  }
                }
              },
              initial: {
                auth: () => {
                  throw new Error("type-only constructor")
                },
                sync: () => {
                  throw new Error("type-only constructor")
                }
              }
            }
          },
          initial: {
            target: "main.work",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        },
        structural: {
          initial: {
            target: "structural.idle",
            data: () => {
              throw new Error("type-only constructor")
            }
          }
        }
      },
      initial: {
        target: "main",
        data: () => {
          throw new Error("type-only constructor")
        }
      }
    })
  })
})
