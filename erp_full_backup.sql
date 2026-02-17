--
-- PostgreSQL database dump
--

\restrict eDwKiFsaZfJ5CuKaEHD3x4PuahU6SbcQJdTTWKnc7bPIYs2u7dvVeJEDix0jFWT

-- Dumped from database version 14.19 (Homebrew)
-- Dumped by pg_dump version 17.7 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: sudammaity
--

-- *not* creating schema, since initdb creates it


ALTER SCHEMA public OWNER TO sudammaity;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: sudammaity
--

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO PUBLIC;


--
-- PostgreSQL database dump complete
--

\unrestrict eDwKiFsaZfJ5CuKaEHD3x4PuahU6SbcQJdTTWKnc7bPIYs2u7dvVeJEDix0jFWT

