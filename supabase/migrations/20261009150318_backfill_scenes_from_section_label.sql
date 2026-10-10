-- Turns each run of consecutive shots (by order_index) sharing a section_label into one
-- scene, numbered from 0 per project in film order, and points those shots at it. Shots
-- with no label stay without a scene. Plain SQL over a temporary table - no function.
create temporary table "_label_runs" on commit drop as
with "ordered" as (
    select
        "id",
        "project_id",
        "order_index",
        "section_label",
        case
            when "section_label" is distinct from lag("section_label") over (partition by "project_id" order by "order_index")
            then 1 else 0
        end as "starts_run"
    from "public"."shots"
),
"runs" as (
    select *, sum("starts_run") over (partition by "project_id" order by "order_index") as "run_no"
    from "ordered"
)
select
    "id",
    "project_id",
    "section_label",
    "run_no",
    (dense_rank() over (partition by "project_id" order by "run_no") - 1)::integer as "position"
from "runs"
where "section_label" is not null;

insert into "public"."scenes" ("project_id", "position", "title")
select distinct "project_id", "position", "section_label"
from "_label_runs";

update "public"."shots" as "s"
set "scene_id" = "sc"."id"
from "_label_runs" as "r"
join "public"."scenes" as "sc" on "sc"."project_id" = "r"."project_id" and "sc"."position" = "r"."position"
where "s"."id" = "r"."id";
