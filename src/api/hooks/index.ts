import payfastHooks from "./payfast"
import { Router } from "express";
import bodyParser from "body-parser";
import { wrapHandler } from "@medusajs/medusa";
import cors from "cors";

const route = Router();

export default (app) => {
  app.use("/payfast", route);

  // route.options(
  //   "/hooks",
  //   cors({
  //     origin: /.*.payfast.com\/apis/gm,
  //     methods: "POST,OPTIONS",
  //   })
  // );
  route.post(
    "/hooks",
    bodyParser.json({ type: "application/json" }),
    wrapHandler(payfastHooks)
  );
  return app;
};
