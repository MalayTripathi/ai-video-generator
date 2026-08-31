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
      elements: {
        Row: {
          created_at: string
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
      generations: {
        Row: {
          created_at: string
          error: string | null
          external_id: string | null
          id: string
          operation: string
          payload: Json | null
          project_id: string
          shot_id: string | null
          started_at: string | null
          state: string
          step: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          external_id?: string | null
          id?: string
          operation: string
          payload?: Json | null
          project_id: string
          shot_id?: string | null
          started_at?: string | null
          state?: string
          step: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          external_id?: string | null
          id?: string
          operation?: string
          payload?: Json | null
          project_id?: string
          shot_id?: string | null
          started_at?: string | null
          state?: string
          step?: string
          updated_at?: string
        }
        Relationships: [
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
          content: string
          created_at: string
          id: string
          project_id: string
          role: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          project_id: string
          role: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          project_id?: string
          role?: string
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
          created_at: string
          current_step: string
          duration_target: string | null
          furthest_step: number
          generating_at: string | null
          id: string
          language: string | null
          language_code: string | null
          source_text: string | null
          status: string
          template_source_id: string | null
          title: string | null
          total_duration_sec: number | null
          tts_model: string | null
          updated_at: string
          user_id: string
          video_model: string | null
          video_type: string | null
          voice_id: string | null
        }
        Insert: {
          aspect_ratio?: string | null
          audio_path?: string | null
          created_at?: string
          current_step?: string
          duration_target?: string | null
          furthest_step?: number
          generating_at?: string | null
          id?: string
          language?: string | null
          language_code?: string | null
          source_text?: string | null
          status?: string
          template_source_id?: string | null
          title?: string | null
          total_duration_sec?: number | null
          tts_model?: string | null
          updated_at?: string
          user_id: string
          video_model?: string | null
          video_type?: string | null
          voice_id?: string | null
        }
        Update: {
          aspect_ratio?: string | null
          audio_path?: string | null
          created_at?: string
          current_step?: string
          duration_target?: string | null
          furthest_step?: number
          generating_at?: string | null
          id?: string
          language?: string | null
          language_code?: string | null
          source_text?: string | null
          status?: string
          template_source_id?: string | null
          title?: string | null
          total_duration_sec?: number | null
          tts_model?: string | null
          updated_at?: string
          user_id?: string
          video_model?: string | null
          video_type?: string | null
          voice_id?: string | null
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
      shots: {
        Row: {
          camera_angle: string | null
          camera_movement: string | null
          camera_overridden: boolean
          created_at: string
          dialogue: Json
          duration_locked: boolean
          duration_sec: number | null
          id: string
          image_path: string | null
          image_prompt: string | null
          image_status: string
          order_index: number
          project_id: string
          section_label: string | null
          shot_key: string
          shot_size: string | null
          updated_at: string
          video_path: string | null
          video_prompt: string | null
          video_status: string
          visual_description: string | null
          voice_over: string
        }
        Insert: {
          camera_angle?: string | null
          camera_movement?: string | null
          camera_overridden?: boolean
          created_at?: string
          dialogue?: Json
          duration_locked?: boolean
          duration_sec?: number | null
          id?: string
          image_path?: string | null
          image_prompt?: string | null
          image_status?: string
          order_index: number
          project_id: string
          section_label?: string | null
          shot_key: string
          shot_size?: string | null
          updated_at?: string
          video_path?: string | null
          video_prompt?: string | null
          video_status?: string
          visual_description?: string | null
          voice_over: string
        }
        Update: {
          camera_angle?: string | null
          camera_movement?: string | null
          camera_overridden?: boolean
          created_at?: string
          dialogue?: Json
          duration_locked?: boolean
          duration_sec?: number | null
          id?: string
          image_path?: string | null
          image_prompt?: string | null
          image_status?: string
          order_index?: number
          project_id?: string
          section_label?: string | null
          shot_key?: string
          shot_size?: string | null
          updated_at?: string
          video_path?: string | null
          video_prompt?: string | null
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
      [_ in never]: never
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
