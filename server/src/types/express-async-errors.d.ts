// `express-async-errors` is a side-effect import that patches Express 4 so a
// rejected promise in an async route handler is forwarded to the error
// middleware instead of hanging the request. It ships no type declarations.
declare module 'express-async-errors';
