export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      credit_ledger: {
        Row: {
          attempt_id: string | null
          created_at: string
          dedupe_key: string
          delta: number
          id: string
          kind: string
          message_id: string | null
          operation: string | null
          price_version: string
          pricing_mode: string | null
          project_id: string | null
          refunds_ledger_id: string | null
          shot_key: string | null
          step: string | null
          user_id: string
        }
        Insert: {
          attempt_id?: string | null
          created_at?: string
          dedupe_key: string
          delta: number
          id?: string
          kind: string
          message_id?: string | null
          operation?: string | null
          price_version: string
          pricing_mode?: string | null
          project_id?: string | null
          refunds_ledger_id?: string | null
          shot_key?: string | null
          step?: string | null
          user_id: string
        }
        Update: {
          attempt_id?: string | null
          created_at?: string
          dedupe_key?: string
          delta?: number
          id?: string
          kind?: string
          message_id?: string | null
          operation?: string | null
          price_version?: string
          pricing_mode?: string | null
          project_id?: string | null
          refunds_ledger_id?: string | null
          shot_key?: string | null
          step?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_refunds_ledger_id_fkey"
            columns: ["refunds_ledger_id"]
            isOneToOne: false
            referencedRelation: "credit_ledger"
            referencedColumns: ["id"]
          },
        ]
      }
      elements: {
        Row: {
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          project_id: string
          reference_image_path: string | null
          status: string
          type: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          project_id: string
          reference_image_path?: string | null
          status?: string
          type: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          project_id?: string
          reference_image_path?: string | null
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "elements_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      exports: {
        Row: {
          chapters_path: string | null
          created_at: string
          duration_sec: number | null
          error: string | null
          film_hash: string
          finished_at: string | null
          id: string
          mp4_path: string | null
          progress: number
          project_id: string
          settings: Json
          size_bytes: number | null
          srt_path: string | null
          started_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          chapters_path?: string | null
          created_at?: string
          duration_sec?: number | null
          error?: string | null
          film_hash: string
          finished_at?: string | null
          id?: string
          mp4_path?: string | null
          progress?: number
          project_id: string
          settings: Json
          size_bytes?: number | null
          srt_path?: string | null
          started_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          chapters_path?: string | null
          created_at?: string
          duration_sec?: number | null
          error?: string | null
          film_hash?: string
          finished_at?: string | null
          id?: string
          mp4_path?: string | null
          progress?: number
          project_id?: string
          settings?: Json
          size_bytes?: number | null
          srt_path?: string | null
          started_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      generations: {
        Row: {
          created_at: string
          element_id: string | null
          error: string | null
          external_id: string | null
          id: string
          operation: string
          payload: Json | null
          project_id: string
          queued_at: string | null
          shot_id: string | null
          started_at: string | null
          state: string
          step: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          element_id?: string | null
          error?: string | null
          external_id?: string | null
          id?: string
          operation: string
          payload?: Json | null
          project_id: string
          queued_at?: string | null
          shot_id?: string | null
          started_at?: string | null
          state?: string
          step: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          element_id?: string | null
          error?: string | null
          external_id?: string | null
          id?: string
          operation?: string
          payload?: Json | null
          project_id?: string
          queued_at?: string | null
          shot_id?: string | null
          started_at?: string | null
          state?: string
          step?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "generations_element_id_fkey"
            columns: ["element_id"]
            isOneToOne: false
            referencedRelation: "elements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          client_id: string | null
          content: string
          created_at: string
          id: string
          kind: string
          project_id: string
          role: string
          shot_key: string | null
          tool_name: string | null
        }
        Insert: {
          client_id?: string | null
          content: string
          created_at?: string
          id?: string
          kind?: string
          project_id: string
          role: string
          shot_key?: string | null
          tool_name?: string | null
        }
        Update: {
          client_id?: string | null
          content?: string
          created_at?: string
          id?: string
          kind?: string
          project_id?: string
          role?: string
          shot_key?: string | null
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          aspect_ratio: string | null
          audio_path: string | null
          caption_mode: string | null
          caption_position: string | null
          caption_style: string | null
          created_at: string
          current_step: string
          duration_target: string | null
          export_motion: string | null
          export_transition: string | null
          furthest_step: number
          id: string
          image_model: string
          image_quality: string
          language: string | null
          language_code: string | null
          last_fit_at: string | null
          last_manual_retime_at: string | null
          loudness_preset: string | null
          mix_duck_bypass: boolean | null
          mix_duck_depth_db: number | null
          mix_music_gain_db: number | null
          mix_voice_gain_db: number | null
          music_duration_sec: number | null
          music_generated_at: string | null
          music_loop: boolean
          music_muted: boolean | null
          music_path: string | null
          music_source: string | null
          music_style_prompt: string | null
          quality_preset: string
          source_text: string | null
          status: string
          template_source_id: string | null
          title: string | null
          total_duration_sec: number | null
          tts_model: string | null
          updated_at: string
          user_id: string
          video_model: string | null
          video_resolution: string
          video_type: string | null
          voice_id: string | null
          voiceover_alignment_path: string | null
          voiceover_generated_at: string | null
          voiceover_muted: boolean
          voiceover_source: string | null
          voiceover_spans: Json | null
          voiceover_stale: boolean
          voiceover_words: Json | null
        }
        Insert: {
          aspect_ratio?: string | null
          audio_path?: string | null
          caption_mode?: string | null
          caption_position?: string | null
          caption_style?: string | null
          created_at?: string
          current_step?: string
          duration_target?: string | null
          export_motion?: string | null
          export_transition?: string | null
          furthest_step?: number
          id?: string
          image_model?: string
          image_quality?: string
          language?: string | null
          language_code?: string | null
          last_fit_at?: string | null
          last_manual_retime_at?: string | null
          loudness_preset?: string | null
          mix_duck_bypass?: boolean | null
          mix_duck_depth_db?: number | null
          mix_music_gain_db?: number | null
          mix_voice_gain_db?: number | null
          music_duration_sec?: number | null
          music_generated_at?: string | null
          music_loop?: boolean
          music_muted?: boolean | null
          music_path?: string | null
          music_source?: string | null
          music_style_prompt?: string | null
          quality_preset?: string
          source_text?: string | null
          status?: string
          template_source_id?: string | null
          title?: string | null
          total_duration_sec?: number | null
          tts_model?: string | null
          updated_at?: string
          user_id: string
          video_model?: string | null
          video_resolution?: string
          video_type?: string | null
          voice_id?: string | null
          voiceover_alignment_path?: string | null
          voiceover_generated_at?: string | null
          voiceover_muted?: boolean
          voiceover_source?: string | null
          voiceover_spans?: Json | null
          voiceover_stale?: boolean
          voiceover_words?: Json | null
        }
        Update: {
          aspect_ratio?: string | null
          audio_path?: string | null
          caption_mode?: string | null
          caption_position?: string | null
          caption_style?: string | null
          created_at?: string
          current_step?: string
          duration_target?: string | null
          export_motion?: string | null
          export_transition?: string | null
          furthest_step?: number
          id?: string
          image_model?: string
          image_quality?: string
          language?: string | null
          language_code?: string | null
          last_fit_at?: string | null
          last_manual_retime_at?: string | null
          loudness_preset?: string | null
          mix_duck_bypass?: boolean | null
          mix_duck_depth_db?: number | null
          mix_music_gain_db?: number | null
          mix_voice_gain_db?: number | null
          music_duration_sec?: number | null
          music_generated_at?: string | null
          music_loop?: boolean
          music_muted?: boolean | null
          music_path?: string | null
          music_source?: string | null
          music_style_prompt?: string | null
          quality_preset?: string
          source_text?: string | null
          status?: string
          template_source_id?: string | null
          title?: string | null
          total_duration_sec?: number | null
          tts_model?: string | null
          updated_at?: string
          user_id?: string
          video_model?: string | null
          video_resolution?: string
          video_type?: string | null
          voice_id?: string | null
          voiceover_alignment_path?: string | null
          voiceover_generated_at?: string | null
          voiceover_muted?: boolean
          voiceover_source?: string | null
          voiceover_spans?: Json | null
          voiceover_stale?: boolean
          voiceover_words?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_template_source_id_fkey"
            columns: ["template_source_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      scenes: {
        Row: {
          created_at: string
          id: string
          location: string | null
          position: number
          project_id: string
          summary: string | null
          target_seconds: number | null
          time_of_day: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          location?: string | null
          position: number
          project_id: string
          summary?: string | null
          target_seconds?: number | null
          time_of_day?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          location?: string | null
          position?: number
          project_id?: string
          summary?: string | null
          target_seconds?: number | null
          time_of_day?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scenes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      shot_dialogue: {
        Row: {
          created_at: string
          element_id: string
          id: string
          line: string
          order_index: number
          project_id: string
          shot_id: string
        }
        Insert: {
          created_at?: string
          element_id: string
          id?: string
          line: string
          order_index: number
          project_id: string
          shot_id: string
        }
        Update: {
          created_at?: string
          element_id?: string
          id?: string
          line?: string
          order_index?: number
          project_id?: string
          shot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shot_dialogue_element_id_fkey"
            columns: ["element_id"]
            isOneToOne: false
            referencedRelation: "elements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_dialogue_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_dialogue_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
        ]
      }
      shot_elements: {
        Row: {
          element_id: string
          shot_id: string
        }
        Insert: {
          element_id: string
          shot_id: string
        }
        Update: {
          element_id?: string
          shot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shot_elements_element_id_fkey"
            columns: ["element_id"]
            isOneToOne: false
            referencedRelation: "elements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_elements_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
        ]
      }
      shot_run_chunks: {
        Row: {
          chunk_index: number
          cost_usd: number
          created_at: string
          error: string | null
          id: string
          max_shots: number
          payload: Json | null
          project_id: string
          run_id: string
          scene_complete: boolean
          scene_id: string
          shots_saved: number
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          chunk_index: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          max_shots: number
          payload?: Json | null
          project_id: string
          run_id: string
          scene_complete?: boolean
          scene_id: string
          shots_saved?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          chunk_index?: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          max_shots?: number
          payload?: Json | null
          project_id?: string
          run_id?: string
          scene_complete?: boolean
          scene_id?: string
          shots_saved?: number
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shot_run_chunks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_run_chunks_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "shot_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_run_chunks_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      shot_runs: {
        Row: {
          agent_generation_id: string | null
          attempt_id: string
          charged_at: string | null
          created_at: string
          finished_at: string | null
          generation_id: string | null
          heartbeat_at: string
          id: string
          kind: string
          message_id: string | null
          outline_cost_usd: number
          project_id: string
          status: string
          stop_reason: string | null
          total_scenes: number | null
          turn_cost_usd: number | null
          turn_settled_at: string | null
          updated_at: string
        }
        Insert: {
          agent_generation_id?: string | null
          attempt_id: string
          charged_at?: string | null
          created_at?: string
          finished_at?: string | null
          generation_id?: string | null
          heartbeat_at?: string
          id?: string
          kind: string
          message_id?: string | null
          outline_cost_usd?: number
          project_id: string
          status?: string
          stop_reason?: string | null
          total_scenes?: number | null
          turn_cost_usd?: number | null
          turn_settled_at?: string | null
          updated_at?: string
        }
        Update: {
          agent_generation_id?: string | null
          attempt_id?: string
          charged_at?: string | null
          created_at?: string
          finished_at?: string | null
          generation_id?: string | null
          heartbeat_at?: string
          id?: string
          kind?: string
          message_id?: string | null
          outline_cost_usd?: number
          project_id?: string
          status?: string
          stop_reason?: string | null
          total_scenes?: number | null
          turn_cost_usd?: number | null
          turn_settled_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shot_runs_agent_generation_id_fkey"
            columns: ["agent_generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_runs_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_runs_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shot_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      shots: {
        Row: {
          binned_at: string | null
          camera_angle: string | null
          camera_angle_origin: string
          camera_movement: string | null
          camera_movement_origin: string
          created_at: string
          duration_locked: boolean
          duration_sec: number | null
          film_duration_sec: number | null
          film_order: number | null
          id: string
          image_path: string | null
          image_prompt: string | null
          image_prompt_edited: boolean
          image_prompt_stale: boolean
          image_stale: boolean
          motion: string | null
          narration_overflow: boolean
          order_index: number
          project_id: string
          scene_id: string | null
          shot_key: string
          shot_size: string | null
          shot_size_origin: string
          split_at: number | null
          split_motion: string | null
          transition_out: string | null
          updated_at: string
          video_path: string | null
          video_prompt: string | null
          video_prompt_stale: boolean
          video_status: string
          visual_description: string | null
          voice_over: string
        }
        Insert: {
          binned_at?: string | null
          camera_angle?: string | null
          camera_angle_origin?: string
          camera_movement?: string | null
          camera_movement_origin?: string
          created_at?: string
          duration_locked?: boolean
          duration_sec?: number | null
          film_duration_sec?: number | null
          film_order?: number | null
          id?: string
          image_path?: string | null
          image_prompt?: string | null
          image_prompt_edited?: boolean
          image_prompt_stale?: boolean
          image_stale?: boolean
          motion?: string | null
          narration_overflow?: boolean
          order_index: number
          project_id: string
          scene_id?: string | null
          shot_key: string
          shot_size?: string | null
          shot_size_origin?: string
          split_at?: number | null
          split_motion?: string | null
          transition_out?: string | null
          updated_at?: string
          video_path?: string | null
          video_prompt?: string | null
          video_prompt_stale?: boolean
          video_status?: string
          visual_description?: string | null
          voice_over: string
        }
        Update: {
          binned_at?: string | null
          camera_angle?: string | null
          camera_angle_origin?: string
          camera_movement?: string | null
          camera_movement_origin?: string
          created_at?: string
          duration_locked?: boolean
          duration_sec?: number | null
          film_duration_sec?: number | null
          film_order?: number | null
          id?: string
          image_path?: string | null
          image_prompt?: string | null
          image_prompt_edited?: boolean
          image_prompt_stale?: boolean
          image_stale?: boolean
          motion?: string | null
          narration_overflow?: boolean
          order_index?: number
          project_id?: string
          scene_id?: string | null
          shot_key?: string
          shot_size?: string | null
          shot_size_origin?: string
          split_at?: number | null
          split_motion?: string | null
          transition_out?: string | null
          updated_at?: string
          video_path?: string | null
          video_prompt?: string | null
          video_prompt_stale?: boolean
          video_status?: string
          visual_description?: string | null
          voice_over?: string
        }
        Relationships: [
          {
            foreignKeyName: "shots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shots_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      usage: {
        Row: {
          created_at: string
          estimated_cost: number | null
          generation_id: string | null
          id: string
          message_id: string | null
          model: string
          operation: string
          project_id: string | null
          provider: string
          quantity: number | null
          quoted_cost: number | null
          rate_version: string | null
          raw_usage: Json | null
          shot_id: string | null
          status: string
          step: string
          stop_reason: string | null
          unit: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          estimated_cost?: number | null
          generation_id?: string | null
          id?: string
          message_id?: string | null
          model: string
          operation: string
          project_id?: string | null
          provider: string
          quantity?: number | null
          quoted_cost?: number | null
          rate_version?: string | null
          raw_usage?: Json | null
          shot_id?: string | null
          status?: string
          step: string
          stop_reason?: string | null
          unit?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          estimated_cost?: number | null
          generation_id?: string | null
          id?: string
          message_id?: string | null
          model?: string
          operation?: string
          project_id?: string | null
          provider?: string
          quantity?: number | null
          quoted_cost?: number | null
          rate_version?: string | null
          raw_usage?: Json | null
          shot_id?: string | null
          status?: string
          step?: string
          stop_reason?: string | null
          unit?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_shot_id_fkey"
            columns: ["shot_id"]
            isOneToOne: false
            referencedRelation: "shots"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      credit_balances: {
        Row: {
          balance: number | null
          entries: number | null
          user_id: string | null
        }
        Relationships: []
      }
      credit_ledger_monthly: {
        Row: {
          credits: number | null
          entries: number | null
          kind: string | null
          month: string | null
          operation: string | null
          project_id: string | null
          step: string | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_monthly_spend: {
        Row: {
          month: string | null
          settled_cost: number | null
          user_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
