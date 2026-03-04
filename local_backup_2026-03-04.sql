--
-- PostgreSQL database dump
--

\restrict xoIfHNqcsohIONg1aC2Jr0DgktvNtrbSasLoPvHeVNMW9q7d3anHWY5uHgtuoyh

-- Dumped from database version 14.19 (Homebrew)
-- Dumped by pg_dump version 14.19 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: student_transport_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.student_transport_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    bus_route_id uuid NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.student_transport_assignments OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    role character varying(50) NOT NULL,
    reference_id uuid,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp with time zone,
    branch_id character varying(255)
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Data for Name: student_transport_assignments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.student_transport_assignments (id, student_id, bus_route_id, is_active, created_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, username, password_hash, role, reference_id, is_active, created_at, updated_at, deleted_at, branch_id) FROM stdin;
c2bb713c-6df7-42ce-8abf-090a3991e6d0	admin	$2b$10$rZBT4N/S2GeZnl15Hc.M.ejdJWUG/gs6DltPtcLGwWLuWWSg0XCNa	Admin	\N	t	2026-02-16 20:41:08.832437+05:30	2026-02-16 20:41:08.832437+05:30	\N	\N
\.


--
-- Name: student_transport_assignments student_transport_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.student_transport_assignments
    ADD CONSTRAINT student_transport_assignments_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- PostgreSQL database dump complete
--

\unrestrict xoIfHNqcsohIONg1aC2Jr0DgktvNtrbSasLoPvHeVNMW9q7d3anHWY5uHgtuoyh

